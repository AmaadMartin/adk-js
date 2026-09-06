/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Ported from adk-python
 * `tests/unittests/optimization/gepa_root_agent_optimizer_test.py` on branch
 * `main`. The `it` strings keep the Python test names so the two suites stay
 * greppable against each other.
 */

import {
  AGENT_PROMPT_NAME,
  GEPARootAgentOptimizer,
  RootAgentGepaAdapter,
  skillComponentKey,
  SkillToolset,
  type EvaluationBatch,
  type UnstructuredSamplingResult,
} from '@google/adk';
import {describe, expect, it} from 'vitest';
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
const SKILL_NAME = 'my_skill';
const SKILL_KEY = skillComponentKey(SKILL_NAME);
const OLD_SKILL_INSTRUCTIONS = 'Old skill inst';
const SKILL_OUTPUT_DIR = scriptOutputDir('adk-gepa-skill-output');
const NEW_SKILL_INSTRUCTIONS = 'New skill inst';

/** A sampler that scores every example, so `evaluate` never warns. */
function createSampler(
  result: UnstructuredSamplingResult = {
    scores: {train1: 1, train2: 1, val1: 1, val2: 1},
  },
): RecordingSampler {
  return new RecordingSampler({
    trainIds: TRAIN_IDS,
    validationIds: VALIDATION_IDS,
    result,
  });
}

/** An adapter whose reflection model is never expected to answer. */
function createAdapter(
  initialAgent = createAgent(),
  sampler = createSampler(),
): RootAgentGepaAdapter {
  return new RootAgentGepaAdapter({
    initialAgent,
    sampler,
    reflectionLm: new RecordingReflectionLm([]).respond,
  });
}

describe('candidate reconstruction', () => {
  it('test_create_agent_from_candidate', async () => {
    const initialAgent = createAgent();
    const sampler = createSampler();
    const adapter = createAdapter(initialAgent, sampler);

    await adapter.evaluate(['train1'], {[AGENT_PROMPT_NAME]: 'New prompt'});

    const built = sampler.calls[0].candidate;
    expect(built).not.toBe(initialAgent);
    expect(built.instruction).toBe('New prompt');
    expect(built.tools).toEqual([]);
    expect(initialAgent.instruction).toBe(INITIAL_INSTRUCTION);
  });

  it('test_update_skill_toolset', async () => {
    const toolset = new SkillToolset(
      [createSkill(SKILL_NAME, OLD_SKILL_INSTRUCTIONS)],
      {scriptOutputDir: SKILL_OUTPUT_DIR},
    );
    const initialAgent = createAgent([toolset]);
    const sampler = createSampler();
    const adapter = createAdapter(initialAgent, sampler);

    await adapter.evaluate(['train1'], {[SKILL_KEY]: NEW_SKILL_INSTRUCTIONS});

    const cloned = onlySkillToolset(sampler.calls[0].candidate);
    expect(cloned).not.toBe(toolset);
    expect(cloned.skills[SKILL_NAME].instructions).toBe(NEW_SKILL_INSTRUCTIONS);
    expect(await cloned.getScriptOutputDir()).toBe(SKILL_OUTPUT_DIR);
    expect(toolset.skills[SKILL_NAME].instructions).toBe(
      OLD_SKILL_INSTRUCTIONS,
    );
  });

  it('test_create_agent_from_candidate_with_skills', async () => {
    const toolset = new SkillToolset([
      createSkill(SKILL_NAME, OLD_SKILL_INSTRUCTIONS),
    ]);
    const initialAgent = createAgent([toolset]);
    const sampler = createSampler();
    const adapter = createAdapter(initialAgent, sampler);

    await adapter.evaluate(['train1'], {
      [AGENT_PROMPT_NAME]: 'New prompt',
      [SKILL_KEY]: NEW_SKILL_INSTRUCTIONS,
    });

    const built = sampler.calls[0].candidate;
    expect(built.instruction).toBe('New prompt');
    expect(built.tools).toHaveLength(1);
    expect(onlySkillToolset(built).skills[SKILL_NAME].instructions).toBe(
      NEW_SKILL_INSTRUCTIONS,
    );
  });
});

describe('RootAgentGepaAdapter', () => {
  it('test_adapter_init', async () => {
    const sampler = createSampler();
    const adapter = createAdapter(createAgent(), sampler);

    await adapter.evaluate(TRAIN_IDS, {[AGENT_PROMPT_NAME]: 'Prompt'});
    await adapter.evaluate(VALIDATION_IDS, {[AGENT_PROMPT_NAME]: 'Prompt'});

    expect(sampler.calls.map((call) => call.exampleSet)).toEqual([
      'train',
      'validation',
    ]);
  });

  it('test_adapter_evaluate_train', async () => {
    const sampler = createSampler({
      scores: {train1: 0.8},
      data: {train1: {output: 'result'}},
    });
    const adapter = createAdapter(createAgent(), sampler);

    const evalBatch = await adapter.evaluate(
      ['train1'],
      {[AGENT_PROMPT_NAME]: 'New prompt'},
      true,
    );

    expect(sampler.calls).toHaveLength(1);
    expect(sampler.calls[0].exampleSet).toBe('train');
    expect(sampler.calls[0].batch).toEqual(['train1']);
    expect(sampler.calls[0].captureFullEvalData).toBe(true);
    expect(sampler.calls[0].candidate.instruction).toBe('New prompt');
    expect(evalBatch.scores).toEqual([0.8]);
    expect(evalBatch.outputs).toEqual([{output: 'result'}]);
    expect(evalBatch.trajectories).toEqual([{output: 'result'}]);
  });

  it('test_adapter_evaluate_validation', async () => {
    const sampler = createSampler({scores: {val1: 0.5}, data: {}});
    const adapter = createAdapter(createAgent(), sampler);

    const evalBatch = await adapter.evaluate(['val1'], {
      [AGENT_PROMPT_NAME]: 'New prompt',
    });

    expect(sampler.calls).toHaveLength(1);
    expect(sampler.calls[0].exampleSet).toBe('validation');
    expect(sampler.calls[0].batch).toEqual(['val1']);
    expect(sampler.calls[0].captureFullEvalData).toBe(false);
    expect(evalBatch.outputs).toEqual([{}]);
  });

  it('test_adapter_make_reflective_dataset', () => {
    const adapter = createAdapter();
    const evalBatch: EvaluationBatch<
      Record<string, unknown>,
      Record<string, unknown>
    > = {
      outputs: [{o: 1}, {o: 2}],
      scores: [0.9, 0.1],
      trajectories: [{t: 'uses my_skill'}, {t: 'does not use skill'}],
    };

    const dataset = adapter.makeReflectiveDataset(
      {[AGENT_PROMPT_NAME]: 'Prompt'},
      evalBatch,
      [AGENT_PROMPT_NAME, SKILL_KEY],
    );

    expect(dataset).toEqual({
      [AGENT_PROMPT_NAME]: [
        {score: 0.9, eval_data: {t: 'uses my_skill'}},
        {score: 0.1, eval_data: {t: 'does not use skill'}},
      ],
      [SKILL_KEY]: [{score: 0.9, eval_data: {t: 'uses my_skill'}}],
    });
  });

  it('test_adapter_rejects_missing_trajectories', () => {
    const adapter = createAdapter();

    expect(() =>
      adapter.makeReflectiveDataset(
        {},
        {outputs: [], scores: [], trajectories: null},
        [],
      ),
    ).toThrow(/without captured trajectories/);
  });

  it('test_adapter_propose_new_texts', async () => {
    const reflectionLm = new RecordingReflectionLm([
      fenced('New prompt'),
      fenced(NEW_SKILL_INSTRUCTIONS),
    ]);
    const adapter = new RootAgentGepaAdapter({
      initialAgent: createAgent(),
      sampler: createSampler(),
      reflectionLm: reflectionLm.respond,
    });

    const newTexts = await adapter.proposeNewTexts(
      {
        [AGENT_PROMPT_NAME]: 'Old prompt',
        [SKILL_KEY]: OLD_SKILL_INSTRUCTIONS,
      },
      {
        [AGENT_PROMPT_NAME]: [{score: 1, eval_data: {}}],
        [SKILL_KEY]: [{score: 0.9, eval_data: {}}],
      },
      [AGENT_PROMPT_NAME, SKILL_KEY],
    );

    expect(reflectionLm.prompts).toHaveLength(2);
    expect(reflectionLm.prompts[0]).toContain(
      'a new version of the agent core instructions',
    );
    expect(reflectionLm.prompts[0]).toContain('Old prompt');
    expect(reflectionLm.prompts[0]).toContain('"score": 1');
    expect(reflectionLm.prompts[1]).toContain(
      `a skill named \`${SKILL_NAME}\``,
    );
    expect(reflectionLm.prompts[1]).toContain(OLD_SKILL_INSTRUCTIONS);
    expect(newTexts).toEqual({
      [AGENT_PROMPT_NAME]: 'New prompt',
      [SKILL_KEY]: NEW_SKILL_INSTRUCTIONS,
    });
  });

  it('test_adapter_evaluate_missing_example_id_in_scores', async () => {
    const sampler = createSampler({
      scores: {train1: 0.8},
      data: {train1: {output: 'result'}},
    });
    const adapter = createAdapter(createAgent(), sampler);

    let evalBatch:
      | EvaluationBatch<Record<string, unknown>, Record<string, unknown>>
      | undefined;
    const warnings = await collectWarnings(async () => {
      evalBatch = await adapter.evaluate(TRAIN_IDS, {
        [AGENT_PROMPT_NAME]: 'New prompt',
      });
    });

    expect(evalBatch?.scores).toEqual([0.8, 0]);
    expect(evalBatch?.outputs).toEqual([{output: 'result'}, {}]);
    expect(evalBatch?.trajectories).toEqual([{output: 'result'}, {}]);
    expect(warnings).toContain(
      'Example train2 missing from sampling result; scoring it 0.',
    );
  });
});

describe('GEPARootAgentOptimizer', () => {
  it('test_optimize', async () => {
    const engine = new FakeGepaEngine(
      runResult([{[AGENT_PROMPT_NAME]: 'Optimized instruction'}], [0.95], {
        full: 'result',
      }),
    );
    const sampler = createSampler();

    const result = await new GEPARootAgentOptimizer({engine}).optimize({
      initialAgent: createAgent(),
      sampler,
    });

    const call = onlyOptimizeCall(engine);
    expect(call.seedCandidate).toEqual({
      [AGENT_PROMPT_NAME]: INITIAL_INSTRUCTION,
    });
    expect(call.trainset).toEqual(TRAIN_IDS);
    expect(call.valset).toEqual(VALIDATION_IDS);
    expect(result.optimizedAgents).toHaveLength(1);
    expect(result.optimizedAgents[0].overallScore).toBe(0.95);
    expect(result.optimizedAgents[0].optimizedAgent.instruction).toBe(
      'Optimized instruction',
    );
    expect(result.gepaResult).toEqual({full: 'result'});
  });

  it('test_optimize_logs_warning_on_overlapping_ids', async () => {
    const engine = new FakeGepaEngine(runResult([], []));
    const sampler = new RecordingSampler({
      trainIds: ['id1', 'id2'],
      validationIds: ['id2', 'id3'],
      result: {scores: {}},
    });

    const warnings = await collectWarnings(async () => {
      await new GEPARootAgentOptimizer({engine}).optimize({
        initialAgent: createAgent(),
        sampler,
      });
    });

    expect(warnings).toContain(
      'The training and validation example UIDs overlap. This WILL cause' +
        ' aliasing issues unless each common UID refers to the same example' +
        ' in both sets.',
    );
  });
});
