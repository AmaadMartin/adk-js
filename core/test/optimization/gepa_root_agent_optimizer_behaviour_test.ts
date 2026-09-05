/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Behaviour this port guarantees beyond the ported adk-python suite: the seed
 * candidate's key order, the toolset clone's forwarded configuration, the
 * proposal prompts, and every error path.
 */

import {
  AGENT_PROMPT_NAME,
  BaseLlm,
  BuiltInCodeExecutor,
  FunctionTool,
  GEPARootAgentOptimizer,
  LLMRegistry,
  RootAgentGepaAdapter,
  SKILL_KEY_PREFIX,
  skillComponentKey,
  SkillToolset,
  type BaseLlmConnection,
  type Frontmatter,
  type LlmRequest,
  type LlmResponse,
  type Skill,
  type SkillRegistry,
} from '@google/adk';
import {beforeAll, describe, expect, it} from 'vitest';
import {
  createAgent,
  createSkill,
  fenced,
  INITIAL_INSTRUCTION,
  onlySkillToolset,
  RecordingReflectionLm,
  scriptOutputDir,
} from './gepa_root_agent_test_utils.js';
import {
  collectWarnings,
  FakeGepaEngine,
  onlyOptimizeCall,
  RecordingSampler,
  runResult,
} from './gepa_test_utils.js';

const TRAIN_IDS = ['train1', 'train2'];
const VALIDATION_IDS = ['val1', 'val2'];
const CLONE_OUTPUT_DIR = scriptOutputDir('adk-gepa-clone-output');

/** A model that counts its own construction and never answers. */
class CountingReflectionLlm extends BaseLlm {
  static override readonly supportedModels: Array<string | RegExp> = [
    /behaviour-gepa-.*/,
  ];

  /** How many times any test built this model. */
  static constructions = 0;

  constructor(params: {model: string}) {
    super(params);
    CountingReflectionLlm.constructions += 1;
  }

  override async *generateContentAsync(): AsyncGenerator<LlmResponse, void> {
    yield {content: {role: 'model', parts: [{text: fenced('Rewritten')}]}};
  }

  override async connect(_llmRequest: LlmRequest): Promise<BaseLlmConnection> {
    return expect.unreachable('CountingReflectionLlm has no live connection.');
  }
}

/** A registry that serves nothing; the tests only compare its identity. */
const EMPTY_REGISTRY: SkillRegistry = {
  getSkill: (name: string): Promise<Skill> =>
    expect.unreachable(`getSkill(${name}) is not expected.`),
  searchSkills: (): Promise<Frontmatter[]> => Promise.resolve([]),
};

function createSampler(): RecordingSampler {
  return new RecordingSampler({
    trainIds: TRAIN_IDS,
    validationIds: VALIDATION_IDS,
    result: {scores: {train1: 1, train2: 1, val1: 1, val2: 1}},
  });
}

function createAdapter(
  initialAgent = createAgent(),
  reflectionLm = new RecordingReflectionLm([]),
): RootAgentGepaAdapter {
  return new RootAgentGepaAdapter({
    initialAgent,
    sampler: createSampler(),
    reflectionLm: reflectionLm.respond,
  });
}

describe('seed candidate', () => {
  it('lists every skill before the agent prompt', async () => {
    const engine = new FakeGepaEngine(runResult([], []));
    const initialAgent = createAgent([
      new SkillToolset([
        createSkill('alpha', 'Alpha instructions'),
        createSkill('beta', 'Beta instructions'),
      ]),
    ]);

    await new GEPARootAgentOptimizer({engine}).optimize({
      initialAgent,
      sampler: createSampler(),
    });

    const {seedCandidate} = onlyOptimizeCall(engine);
    expect(Object.keys(seedCandidate)).toEqual([
      skillComponentKey('alpha'),
      skillComponentKey('beta'),
      AGENT_PROMPT_NAME,
    ]);
    expect(seedCandidate[skillComponentKey('alpha')]).toBe(
      'Alpha instructions',
    );
  });

  it('holds only the agent prompt when the agent exposes no skills', async () => {
    const engine = new FakeGepaEngine(runResult([], []));

    await new GEPARootAgentOptimizer({engine}).optimize({
      initialAgent: createAgent([
        new FunctionTool({
          name: 'ping',
          description: 'A tool.',
          execute: async () => 'pong',
        }),
      ]),
      sampler: createSampler(),
    });

    expect(onlyOptimizeCall(engine).seedCandidate).toEqual({
      [AGENT_PROMPT_NAME]: INITIAL_INSTRUCTION,
    });
  });
});

describe('candidate reconstruction', () => {
  it('keeps a skill the candidate does not mention', async () => {
    const sampler = createSampler();
    const adapter = new RootAgentGepaAdapter({
      initialAgent: createAgent([
        new SkillToolset([
          createSkill('alpha', 'Alpha instructions'),
          createSkill('beta', 'Beta instructions'),
        ]),
      ]),
      sampler,
      reflectionLm: new RecordingReflectionLm([]).respond,
    });

    await adapter.evaluate(['train1'], {
      [skillComponentKey('alpha')]: 'Rewritten alpha',
    });

    const skills = onlySkillToolset(sampler.calls[0].candidate).skills;
    expect(skills['alpha'].instructions).toBe('Rewritten alpha');
    expect(skills['beta'].instructions).toBe('Beta instructions');
  });

  it('passes a tool that is not a skill toolset through by identity', async () => {
    const tool = new FunctionTool({
      name: 'ping',
      description: 'A tool.',
      execute: async () => 'pong',
    });
    const sampler = createSampler();
    const adapter = new RootAgentGepaAdapter({
      initialAgent: createAgent([tool]),
      sampler,
      reflectionLm: new RecordingReflectionLm([]).respond,
    });

    await adapter.evaluate(['train1'], {[AGENT_PROMPT_NAME]: 'New prompt'});

    expect(sampler.calls[0].candidate.tools).toEqual([tool]);
    expect(sampler.calls[0].candidate.tools[0]).toBe(tool);
  });
});

describe('SkillToolset.cloneWithUpdatedSkills', () => {
  it('forwards every constructor option and leaves the original alone', async () => {
    const codeExecutor = new BuiltInCodeExecutor();
    const additionalTool = new FunctionTool({
      name: 'ping',
      description: 'A tool.',
      execute: async () => 'pong',
    });
    const toolset = new SkillToolset([createSkill('alpha', 'Alpha')], {
      codeExecutor,
      additionalTools: [additionalTool],
      registry: EMPTY_REGISTRY,
      allowInlineScripts: true,
      scriptOutputDir: CLONE_OUTPUT_DIR,
    });

    const clone = toolset.cloneWithUpdatedSkills([
      createSkill('alpha', 'Rewritten alpha'),
    ]);

    expect(clone).not.toBe(toolset);
    expect(clone.codeExecutor).toBe(codeExecutor);
    expect(clone.additionalTools).toEqual([additionalTool]);
    expect(clone.registry).toBe(EMPTY_REGISTRY);
    expect(await clone.getScriptOutputDir()).toBe(CLONE_OUTPUT_DIR);
    expect((await clone.getTools()).map((tool) => tool.name)).toEqual(
      (await toolset.getTools()).map((tool) => tool.name),
    );
    expect((await clone.getTools()).map((tool) => tool.name)).toContain(
      'run_skill_inline_script',
    );
    expect(toolset.skills['alpha'].instructions).toBe('Alpha');
  });

  it('omits the inline script tool when the original did not enable it', async () => {
    const clone = new SkillToolset([
      createSkill('alpha', 'Alpha'),
    ]).cloneWithUpdatedSkills([createSkill('alpha', 'Rewritten alpha')]);

    expect((await clone.getTools()).map((tool) => tool.name)).not.toContain(
      'run_skill_inline_script',
    );
  });
});

describe('proposeNewTexts', () => {
  it('rejects a component that is neither the prompt nor a skill', async () => {
    await expect(
      createAdapter().proposeNewTexts({}, {}, ['mystery_component']),
    ).rejects.toThrow('Unknown component type for update: mystery_component');
  });

  it('rejects a reply carrying no fenced block', async () => {
    const reflectionLm = new RecordingReflectionLm(['No block here.']);

    await expect(
      createAdapter(createAgent(), reflectionLm).proposeNewTexts(
        {[AGENT_PROMPT_NAME]: 'Old prompt'},
        {[AGENT_PROMPT_NAME]: []},
        [AGENT_PROMPT_NAME],
      ),
    ).rejects.toThrow(/no fenced block for component agent_prompt/);
  });

  it('takes the last fenced block when the model restates the input', async () => {
    const reflectionLm = new RecordingReflectionLm([
      `Here is what you gave me:\n${fenced('Old prompt')}\n` +
        `Here is the rewrite:\n${fenced('Rewritten prompt')}`,
    ]);

    const newTexts = await createAdapter(
      createAgent(),
      reflectionLm,
    ).proposeNewTexts(
      {[AGENT_PROMPT_NAME]: 'Old prompt'},
      {
        [AGENT_PROMPT_NAME]: [],
      },
      [AGENT_PROMPT_NAME],
    );

    expect(newTexts).toEqual({[AGENT_PROMPT_NAME]: 'Rewritten prompt'});
  });

  it('substitutes the current text literally, without expanding $ patterns', async () => {
    const reflectionLm = new RecordingReflectionLm([fenced('Rewritten')]);

    await createAdapter(createAgent(), reflectionLm).proposeNewTexts(
      {[AGENT_PROMPT_NAME]: 'Quote the total as $& and $1.'},
      {[AGENT_PROMPT_NAME]: []},
      [AGENT_PROMPT_NAME],
    );

    expect(reflectionLm.prompts[0]).toContain('Quote the total as $& and $1.');
    expect(reflectionLm.prompts[0]).not.toContain('<curr_param>');
    expect(reflectionLm.prompts[0]).not.toContain('<side_info>');
  });
});

describe('error paths', () => {
  it('throws before the sampler runs when no engine is configured', async () => {
    const sampler = createSampler();

    await expect(
      new GEPARootAgentOptimizer().optimize({
        initialAgent: createAgent(),
        sampler,
      }),
    ).rejects.toThrow(/requires a GEPA engine/);
    expect(sampler.calls).toEqual([]);
  });

  it('rejects an instruction provider', async () => {
    await expect(
      new GEPARootAgentOptimizer({
        engine: new FakeGepaEngine(runResult([], [])),
      }).optimize({
        initialAgent: createAgent([], async () => 'Built per request.'),
        sampler: createSampler(),
      }),
    ).rejects.toThrow(/static string/);
  });

  it('rejects a batch that spans both example sets', async () => {
    await expect(
      createAdapter().evaluate(['train1', 'val1'], {
        [AGENT_PROMPT_NAME]: 'New prompt',
      }),
    ).rejects.toThrow('Invalid batch composition: train1,val1');
  });

  it('rejects an engine reporting fewer scores than candidates', async () => {
    const engine = new FakeGepaEngine(
      runResult([{[AGENT_PROMPT_NAME]: 'a'}, {[AGENT_PROMPT_NAME]: 'b'}], [1]),
    );

    await expect(
      new GEPARootAgentOptimizer({engine}).optimize({
        initialAgent: createAgent(),
        sampler: createSampler(),
      }),
    ).rejects.toThrow('GEPA reported 2 candidates and 1 validation scores');
  });

  it('rejects an eval batch with fewer trajectories than scores', () => {
    expect(() =>
      createAdapter().makeReflectiveDataset(
        {},
        {outputs: [{}], scores: [1, 0.5], trajectories: [{}]},
        [AGENT_PROMPT_NAME],
      ),
    ).toThrow('GEPA reported 2 scores and 1 trajectories');
  });
});

describe('warnings', () => {
  it('warns that sub-agent instructions are left alone', async () => {
    const engine = new FakeGepaEngine(runResult([], []));
    const initialAgent = createAgent();
    initialAgent.subAgents.push(createAgent());

    const warnings = await collectWarnings(async () => {
      await new GEPARootAgentOptimizer({engine}).optimize({
        initialAgent,
        sampler: createSampler(),
      });
    });

    expect(warnings).toContain(
      'The GEPARootAgentOptimizer will not optimize prompts for sub-agents.',
    );
  });
});

describe('the reflection model', () => {
  beforeAll(() => {
    LLMRegistry.register(CountingReflectionLlm);
  });

  it('is not built when the engine never reflects', async () => {
    const before = CountingReflectionLlm.constructions;
    const engine = new FakeGepaEngine(runResult([], []));

    await new GEPARootAgentOptimizer({
      engine,
      optimizerModel: 'behaviour-gepa-reflector',
    }).optimize({initialAgent: createAgent(), sampler: createSampler()});

    expect(CountingReflectionLlm.constructions).toBe(before);
  });

  it('is built once and reused across reflections', async () => {
    const before = CountingReflectionLlm.constructions;
    const engine: FakeGepaEngine = new FakeGepaEngine(runResult([], []));
    const optimizer = new GEPARootAgentOptimizer({
      engine,
      optimizerModel: 'behaviour-gepa-reflector',
    });

    await optimizer.optimize({
      initialAgent: createAgent(),
      sampler: createSampler(),
    });
    const {reflectionLm} = onlyOptimizeCall(engine);
    expect(await reflectionLm('Rewrite it.')).toBe(fenced('Rewritten'));
    expect(await reflectionLm('Rewrite it again.')).toBe(fenced('Rewritten'));

    expect(CountingReflectionLlm.constructions).toBe(before + 1);
  });
});

describe('skill component keys', () => {
  it('carries the adk-python key format', () => {
    expect(SKILL_KEY_PREFIX).toBe('skill_instructions:');
    expect(skillComponentKey('my_skill')).toBe('skill_instructions:my_skill');
  });
});
