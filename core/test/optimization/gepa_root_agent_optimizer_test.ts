/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {afterEach, describe, expect, it, vi} from 'vitest';

// This is a white-box test of module-internal helpers (updateSkillToolset,
// createAgentFromCandidate, RootAgentGepaAdapter) that are not part of the
// public `@google/adk` surface, so every symbol is imported from source to keep
// the branded agent/tool types consistent. The public API and a real
// end-to-end run are exercised separately in the e2e test.
import {LlmAgent} from '../../src/agents/llm_agent.js';
import {UnstructuredSamplingResult} from '../../src/optimization/data_types.js';
import {optimize as engineOptimize} from '../../src/optimization/gepa/engine.js';
import {
  extractProposedInstruction,
  renderInstructionProposal,
} from '../../src/optimization/gepa/instruction_proposal.js';
import {
  createAgentFromCandidate,
  GEPARootAgentOptimizer,
  GEPARootAgentOptimizerConfig,
  RootAgentGepaAdapter,
  updateSkillToolset,
} from '../../src/optimization/gepa_root_agent_optimizer.js';
import {Sampler} from '../../src/optimization/sampler.js';
import {Skill} from '../../src/skills/skill.js';
import {SkillToolset} from '../../src/tools/skill/skill_toolset.js';
import {logger} from '../../src/utils/logger.js';

vi.mock('../../src/optimization/gepa/engine.js', () => ({
  optimize: vi.fn(),
}));

vi.mock('../../src/optimization/gepa/instruction_proposal.js', () => ({
  renderInstructionProposal: vi.fn(() => 'rendered prompt'),
  extractProposedInstruction: vi.fn(),
}));

type SampleAndScore = Sampler<UnstructuredSamplingResult>['sampleAndScore'];

function makeSampler(
  train: string[],
  val: string[],
  sampleAndScore: SampleAndScore = vi.fn(async () => ({scores: {}})),
): Sampler<UnstructuredSamplingResult> {
  return {
    getTrainExampleIds: () => train,
    getValidationExampleIds: () => val,
    sampleAndScore,
  } as unknown as Sampler<UnstructuredSamplingResult>;
}

function makeSkill(name: string, instructions: string): Skill {
  return {frontmatter: {name, description: 'desc'}, instructions};
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

describe('updateSkillToolset', () => {
  it('updates matching skills and leaves others untouched', () => {
    const toolset = new SkillToolset([
      makeSkill('my_skill', 'Old skill inst'),
      makeSkill('other_skill', 'Other inst'),
    ]);
    const candidate = {'skill_instructions:my_skill': 'New skill inst'};

    const result = updateSkillToolset(toolset, candidate);

    expect(result).toBeInstanceOf(SkillToolset);
    expect(result).not.toBe(toolset);
    expect(result.skills['my_skill'].instructions).toBe('New skill inst');
    expect(result.skills['other_skill'].instructions).toBe('Other inst');
    // Original toolset is not mutated.
    expect(toolset.skills['my_skill'].instructions).toBe('Old skill inst');
  });
});

describe('createAgentFromCandidate', () => {
  it('clones the agent with the new instruction when there are no skills', () => {
    const agent = new LlmAgent({name: 'agent', instruction: 'Initial'});
    const cloneSpy = vi.spyOn(agent, 'clone').mockReturnValue(agent);

    const newAgent = createAgentFromCandidate(agent, {
      agent_prompt: 'New prompt',
    });

    expect(cloneSpy).toHaveBeenCalledWith({instruction: 'New prompt'});
    expect(newAgent).toBe(agent);
    expect(newAgent.tools).toEqual([]);
  });

  it('falls back to the initial instruction when no agent_prompt is present', () => {
    const agent = new LlmAgent({name: 'agent', instruction: 'Initial'});
    const cloneSpy = vi.spyOn(agent, 'clone').mockReturnValue(agent);

    createAgentFromCandidate(agent, {});

    expect(cloneSpy).toHaveBeenCalledWith({instruction: 'Initial'});
  });

  it('rebuilds SkillToolset tools and preserves non-skill tools', () => {
    const toolset = new SkillToolset([makeSkill('my_skill', 'Old skill inst')]);
    const agent = new LlmAgent({name: 'agent', instruction: 'Initial'});
    const otherTool = {
      name: 'not_a_skill_toolset',
    } as unknown as (typeof agent.tools)[number];
    agent.tools = [toolset, otherTool];

    const candidate = {
      agent_prompt: 'New prompt',
      'skill_instructions:my_skill': 'New skill inst',
    };

    const newAgent = createAgentFromCandidate(agent, candidate);

    expect(newAgent.tools).toHaveLength(2);
    const rebuilt = newAgent.tools[0] as unknown as SkillToolset;
    expect(rebuilt).toBeInstanceOf(SkillToolset);
    expect(rebuilt).not.toBe(toolset);
    expect(rebuilt.skills['my_skill'].instructions).toBe('New skill inst');
    // Non-SkillToolset tools are carried over by reference.
    expect(newAgent.tools[1]).toBe(otherTool);
    // Original agent's tools are untouched.
    expect(agent.tools[0]).toBe(toolset);
    expect(toolset.skills['my_skill'].instructions).toBe('Old skill inst');
  });
});

describe('RootAgentGepaAdapter', () => {
  const reflectionLm = vi.fn(async () => 'lm output');

  it('evaluate scores a train batch and captures traces', async () => {
    const agent = new LlmAgent({name: 'agent', instruction: 'Initial'});
    const cloneSpy = vi.spyOn(agent, 'clone').mockReturnValue(agent);
    const sampleAndScore = vi.fn(async () => ({
      scores: {train1: 0.8},
      data: {train1: {output: 'result'}},
    }));
    const sampler = makeSampler(
      ['train1', 'train2'],
      ['val1', 'val2'],
      sampleAndScore,
    );
    const adapter = new RootAgentGepaAdapter(
      agent,
      sampler,
      new Set(['train1', 'train2']),
      new Set(['val1', 'val2']),
      reflectionLm,
    );

    const evalBatch = await adapter.evaluate(
      ['train1'],
      {agent_prompt: 'New prompt'},
      true,
    );

    expect(cloneSpy).toHaveBeenCalledWith({instruction: 'New prompt'});
    expect(sampleAndScore).toHaveBeenCalledWith(
      agent,
      'train',
      ['train1'],
      true,
    );
    expect(evalBatch.scores).toEqual([0.8]);
    expect(evalBatch.outputs).toEqual([{output: 'result'}]);
    expect(evalBatch.trajectories).toEqual([{output: 'result'}]);
  });

  it('evaluate scores a validation batch with the default capture flag', async () => {
    const agent = new LlmAgent({name: 'agent', instruction: 'Initial'});
    vi.spyOn(agent, 'clone').mockReturnValue(agent);
    const sampleAndScore = vi.fn(async () => ({scores: {val1: 0.5}, data: {}}));
    const sampler = makeSampler(
      ['train1', 'train2'],
      ['val1', 'val2'],
      sampleAndScore,
    );
    const adapter = new RootAgentGepaAdapter(
      agent,
      sampler,
      new Set(['train1', 'train2']),
      new Set(['val1', 'val2']),
      reflectionLm,
    );

    const evalBatch = await adapter.evaluate(['val1'], {agent_prompt: 'New'});

    expect(sampleAndScore).toHaveBeenCalledWith(
      agent,
      'validation',
      ['val1'],
      false,
    );
    expect(evalBatch.scores).toEqual([0.5]);
    expect(evalBatch.outputs).toEqual([{}]);
  });

  it('evaluate throws on an invalid batch composition', async () => {
    const agent = new LlmAgent({name: 'agent', instruction: 'Initial'});
    vi.spyOn(agent, 'clone').mockReturnValue(agent);
    const sampler = makeSampler(['train1'], ['val1']);
    const adapter = new RootAgentGepaAdapter(
      agent,
      sampler,
      new Set(['train1']),
      new Set(['val1']),
      reflectionLm,
    );

    await expect(
      adapter.evaluate(['train1', 'val1'], {agent_prompt: 'x'}),
    ).rejects.toThrow('Invalid batch composition');
  });

  it('makeReflectiveDataset filters skill examples by name substring', () => {
    const agent = new LlmAgent({name: 'agent', instruction: 'Initial'});
    const adapter = new RootAgentGepaAdapter(
      agent,
      makeSampler([], []),
      new Set(),
      new Set(),
      reflectionLm,
    );

    const dataset = adapter.makeReflectiveDataset(
      {agent_prompt: 'Prompt'},
      {
        outputs: [{o: 1}, {o: 2}],
        scores: [0.9, 0.1],
        trajectories: [{t: 'uses my_skill'}, {t: 'does not use skill'}],
      },
      ['agent_prompt', 'skill_instructions:my_skill'],
    );

    expect(dataset).toEqual({
      agent_prompt: [
        {score: 0.9, eval_data: {t: 'uses my_skill'}},
        {score: 0.1, eval_data: {t: 'does not use skill'}},
      ],
      'skill_instructions:my_skill': [
        {score: 0.9, eval_data: {t: 'uses my_skill'}},
      ],
    });
  });

  it('makeReflectiveDataset throws on mismatched score/trajectory lengths', () => {
    const agent = new LlmAgent({name: 'agent', instruction: 'Initial'});
    const adapter = new RootAgentGepaAdapter(
      agent,
      makeSampler([], []),
      new Set(),
      new Set(),
      reflectionLm,
    );

    expect(() =>
      adapter.makeReflectiveDataset(
        {agent_prompt: 'P'},
        {outputs: [{}], scores: [0.9, 0.1], trajectories: [{t: 1}]},
        ['agent_prompt'],
      ),
    ).toThrow('Mismatched');
  });

  it('makeReflectiveDataset throws when trajectories are absent', () => {
    const agent = new LlmAgent({name: 'agent', instruction: 'Initial'});
    const adapter = new RootAgentGepaAdapter(
      agent,
      makeSampler([], []),
      new Set(),
      new Set(),
      reflectionLm,
    );

    expect(() =>
      adapter.makeReflectiveDataset(
        {agent_prompt: 'P'},
        {outputs: [{}], scores: [0.9], trajectories: null},
        ['agent_prompt'],
      ),
    ).toThrow('Mismatched');
  });

  it('proposeNewTexts renders, calls the LM, and extracts per component', async () => {
    vi.mocked(extractProposedInstruction)
      .mockReturnValueOnce('New prompt')
      .mockReturnValueOnce('New skill inst');
    const lm = vi.fn(async () => 'lm output');
    const agent = new LlmAgent({name: 'agent', instruction: 'Initial'});
    const adapter = new RootAgentGepaAdapter(
      agent,
      makeSampler([], []),
      new Set(),
      new Set(),
      lm,
    );

    const newTexts = await adapter.proposeNewTexts(
      {
        agent_prompt: 'Old prompt',
        'skill_instructions:my_skill': 'Old skill inst',
      },
      {
        agent_prompt: [{score: 1.0, eval_data: {}}],
        'skill_instructions:my_skill': [{score: 0.9, eval_data: {}}],
      },
      ['agent_prompt', 'skill_instructions:my_skill'],
    );

    expect(renderInstructionProposal).toHaveBeenCalledTimes(2);
    expect(lm).toHaveBeenCalledTimes(2);
    expect(extractProposedInstruction).toHaveBeenCalledTimes(2);
    expect(newTexts).toEqual({
      agent_prompt: 'New prompt',
      'skill_instructions:my_skill': 'New skill inst',
    });
  });

  it('proposeNewTexts throws on an unknown component key', async () => {
    const agent = new LlmAgent({name: 'agent', instruction: 'Initial'});
    const adapter = new RootAgentGepaAdapter(
      agent,
      makeSampler([], []),
      new Set(),
      new Set(),
      reflectionLm,
    );

    await expect(
      adapter.proposeNewTexts({unknown: 'x'}, {unknown: []}, ['unknown']),
    ).rejects.toThrow('Unknown component type for update: unknown');
  });
});

describe('GEPARootAgentOptimizer', () => {
  function mockEngineResult(
    candidates: Array<Record<string, string>>,
    valAggregateScores: number[],
    json: Record<string, unknown> = {full: 'result'},
  ) {
    vi.mocked(engineOptimize).mockResolvedValue({
      candidates,
      valAggregateScores,
      bestScore: valAggregateScores[0] ?? 0,
      totalMetricCalls: 10,
      toJSON: () => json,
    });
  }

  it('wires the seed candidate into the engine and maps candidates back', async () => {
    mockEngineResult([{agent_prompt: 'Optimized instruction'}], [0.95]);

    const agent = new LlmAgent({
      name: 'agent',
      instruction: 'Initial instruction',
    });
    const cloneSpy = vi.spyOn(agent, 'clone').mockReturnValue(agent);
    const sampler = makeSampler(['train1', 'train2'], ['val1', 'val2']);
    const optimizer = new GEPARootAgentOptimizer(
      new GEPARootAgentOptimizerConfig(),
    );

    const result = await optimizer.optimize(agent, sampler);

    expect(engineOptimize).toHaveBeenCalledTimes(1);
    const callArg = vi.mocked(engineOptimize).mock.calls[0][0];
    expect(callArg.seedCandidate).toEqual({
      agent_prompt: 'Initial instruction',
    });
    expect(callArg.trainset).toEqual(['train1', 'train2']);
    expect(callArg.valset).toEqual(['val1', 'val2']);

    expect(result.optimizedAgents).toHaveLength(1);
    expect(result.optimizedAgents[0].overallScore).toBe(0.95);
    expect(cloneSpy).toHaveBeenCalledWith({
      instruction: 'Optimized instruction',
    });
    expect(result.gepaResult).toEqual({full: 'result'});
  });

  it('seeds skill instructions before the core prompt', async () => {
    mockEngineResult([], []);

    const skillA = makeSkill('skill_a', 'A inst');
    const skillB = makeSkill('skill_b', 'B inst');
    const agent = new LlmAgent({
      name: 'agent',
      instruction: 'Core instruction',
      tools: [new SkillToolset([skillA, skillB])],
    });
    const sampler = makeSampler(['t'], ['v']);
    const optimizer = new GEPARootAgentOptimizer(
      new GEPARootAgentOptimizerConfig(),
    );

    await optimizer.optimize(agent, sampler);

    const seed = vi.mocked(engineOptimize).mock.calls[0][0].seedCandidate;
    expect(Object.keys(seed)).toEqual([
      'skill_instructions:skill_a',
      'skill_instructions:skill_b',
      'agent_prompt',
    ]);
    expect(seed).toEqual({
      'skill_instructions:skill_a': 'A inst',
      'skill_instructions:skill_b': 'B inst',
      agent_prompt: 'Core instruction',
    });
  });

  it('warns when the training and validation ids overlap', async () => {
    mockEngineResult([], [], {});
    const warnSpy = vi.spyOn(logger, 'warn');
    const agent = new LlmAgent({name: 'agent', instruction: 'i'});
    vi.spyOn(agent, 'clone').mockReturnValue(agent);
    const sampler = makeSampler(['id1', 'id2'], ['id2', 'id3']);
    const optimizer = new GEPARootAgentOptimizer(
      new GEPARootAgentOptimizerConfig(),
    );

    await optimizer.optimize(agent, sampler);

    expect(warnSpy).toHaveBeenCalledWith(
      'The training and validation example UIDs overlap. This WILL cause' +
        ' aliasing issues unless each common UID refers to the same example' +
        ' in both sets.',
    );
  });

  it('warns when the initial agent has sub-agents', async () => {
    mockEngineResult([], [], {});
    const warnSpy = vi.spyOn(logger, 'warn');
    const child = new LlmAgent({name: 'child', instruction: 'c'});
    const agent = new LlmAgent({
      name: 'parent',
      instruction: 'i',
      subAgents: [child],
    });
    vi.spyOn(agent, 'clone').mockReturnValue(agent);
    const sampler = makeSampler(['t'], ['v']);
    const optimizer = new GEPARootAgentOptimizer(
      new GEPARootAgentOptimizerConfig(),
    );

    await optimizer.optimize(agent, sampler);

    expect(warnSpy).toHaveBeenCalledWith(
      'The GEPARootAgentOptimizer will not optimize prompts for sub-agents.',
    );
  });

  it('throws when the instruction is an InstructionProvider', async () => {
    const agent = new LlmAgent({name: 'agent', instruction: () => 'dynamic'});
    const sampler = makeSampler(['t'], ['v']);
    const optimizer = new GEPARootAgentOptimizer(
      new GEPARootAgentOptimizerConfig(),
    );

    await expect(optimizer.optimize(agent, sampler)).rejects.toThrow(
      'requires a string instruction',
    );
  });

  it('applies configuration defaults and overrides', () => {
    const config = new GEPARootAgentOptimizerConfig();
    expect(config.optimizerModel).toBe('gemini-3.5-flash');
    expect(config.maxMetricCalls).toBe(100);
    expect(config.reflectionMinibatchSize).toBe(3);
    expect(config.runDir).toBeNull();
    expect(config.modelConfiguration.thinkingConfig).toEqual({
      includeThoughts: true,
      thinkingBudget: 10240,
    });

    const custom = new GEPARootAgentOptimizerConfig({
      optimizerModel: 'gemini-2.5-pro',
      maxMetricCalls: 5,
      reflectionMinibatchSize: 1,
      runDir: '/tmp/run',
    });
    expect(custom.optimizerModel).toBe('gemini-2.5-pro');
    expect(custom.maxMetricCalls).toBe(5);
    expect(custom.reflectionMinibatchSize).toBe(1);
    expect(custom.runDir).toBe('/tmp/run');
  });
});
