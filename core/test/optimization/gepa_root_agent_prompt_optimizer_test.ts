/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  AgentGepaAdapter,
  EvaluationBatch,
  GEPARootAgentPromptOptimizer,
  GEPARootAgentPromptOptimizerConfig,
  LlmAgent,
  Sampler,
  UnstructuredSamplingResult,
} from '@google/adk';
import {afterEach, describe, expect, it, vi} from 'vitest';

import {optimize as engineOptimize} from '../../src/optimization/gepa/engine.js';
import {logger} from '../../src/utils/logger.js';

vi.mock('../../src/optimization/gepa/engine.js', () => ({
  optimize: vi.fn(),
}));

type EvalData = Record<string, unknown>;
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
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('AgentGepaAdapter', () => {
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
    const adapter = new AgentGepaAdapter(
      agent,
      sampler,
      new Set(['train1', 'train2']),
      new Set(['val1', 'val2']),
    );

    const evalBatch = await adapter.evaluate(['train1'], {
      agent_prompt: 'New prompt',
    });

    expect(cloneSpy).toHaveBeenCalledWith({instruction: 'New prompt'});
    expect(sampleAndScore).toHaveBeenCalledWith(
      agent,
      'train',
      ['train1'],
      false,
    );
    expect(evalBatch.scores).toEqual([0.8]);
    expect(evalBatch.outputs).toEqual([{output: 'result'}]);
    expect(evalBatch.trajectories).toEqual([{output: 'result'}]);
  });

  it('evaluate scores a validation batch with the requested capture flag', async () => {
    const agent = new LlmAgent({name: 'agent', instruction: 'Initial'});
    vi.spyOn(agent, 'clone').mockReturnValue(agent);
    const sampleAndScore = vi.fn(async () => ({scores: {val1: 0.5}, data: {}}));
    const sampler = makeSampler(
      ['train1', 'train2'],
      ['val1', 'val2'],
      sampleAndScore,
    );
    const adapter = new AgentGepaAdapter(
      agent,
      sampler,
      new Set(['train1', 'train2']),
      new Set(['val1', 'val2']),
    );

    const evalBatch = await adapter.evaluate(
      ['val1'],
      {agent_prompt: 'New prompt'},
      true,
    );

    expect(sampleAndScore).toHaveBeenCalledWith(
      agent,
      'validation',
      ['val1'],
      true,
    );
    expect(evalBatch.scores).toEqual([0.5]);
    expect(evalBatch.outputs).toEqual([{}]);
  });

  it('evaluate throws on an invalid batch composition', async () => {
    const agent = new LlmAgent({name: 'agent', instruction: 'Initial'});
    vi.spyOn(agent, 'clone').mockReturnValue(agent);
    const sampler = makeSampler(['train1', 'train2'], ['val1', 'val2']);
    const adapter = new AgentGepaAdapter(
      agent,
      sampler,
      new Set(['train1', 'train2']),
      new Set(['val1', 'val2']),
    );

    await expect(
      adapter.evaluate(['train1', 'val1'], {agent_prompt: 'x'}),
    ).rejects.toThrow('Invalid batch composition');
  });

  it('makeReflectiveDataset builds one row per instance per component', () => {
    const agent = new LlmAgent({name: 'agent', instruction: 'Initial'});
    const adapter = new AgentGepaAdapter(
      agent,
      makeSampler([], []),
      new Set(),
      new Set(),
    );
    const evalBatch: EvaluationBatch<EvalData, EvalData> = {
      outputs: [{o: 1}, {o: 2}],
      scores: [0.9, 0.1],
      trajectories: [{t: 1}, {t: 2}],
    };

    const dataset = adapter.makeReflectiveDataset(
      {agent_prompt: 'Prompt'},
      evalBatch,
      ['component1'],
    );

    expect(dataset.component1).toHaveLength(2);
    expect(dataset.component1[0]).toEqual({
      agent_prompt: 'Prompt',
      score: 0.9,
      eval_data: {t: 1},
    });
    expect(dataset.component1[1]).toEqual({
      agent_prompt: 'Prompt',
      score: 0.1,
      eval_data: {t: 2},
    });
  });

  it('makeReflectiveDataset throws when trajectories do not match scores', () => {
    const agent = new LlmAgent({name: 'agent', instruction: 'Initial'});
    const adapter = new AgentGepaAdapter(
      agent,
      makeSampler([], []),
      new Set(),
      new Set(),
    );
    const makeDataset = (evalBatch: EvaluationBatch<EvalData, EvalData>) =>
      adapter.makeReflectiveDataset({agent_prompt: 'P'}, evalBatch, ['c']);

    expect(() =>
      makeDataset({outputs: [{}], scores: [0.9, 0.1], trajectories: [{t: 1}]}),
    ).toThrow('Mismatched');
    expect(() =>
      makeDataset({outputs: [{}], scores: [0.9], trajectories: null}),
    ).toThrow('Mismatched');
  });
});

describe('GEPARootAgentPromptOptimizer', () => {
  it('wires the seed candidate into the engine and maps candidates back', async () => {
    vi.mocked(engineOptimize).mockResolvedValue({
      candidates: [{agent_prompt: 'Optimized instruction'}],
      valAggregateScores: [0.95],
      bestScore: 0.95,
      totalMetricCalls: 10,
      toJSON: () => ({full: 'result'}),
    });

    const agent = new LlmAgent({
      name: 'agent',
      instruction: 'Initial instruction',
    });
    const cloneSpy = vi.spyOn(agent, 'clone').mockReturnValue(agent);
    const sampler = makeSampler(['train1', 'train2'], ['val1', 'val2']);
    const optimizer = new GEPARootAgentPromptOptimizer(
      new GEPARootAgentPromptOptimizerConfig(),
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

  it('warns when the training and validation ids overlap', async () => {
    vi.mocked(engineOptimize).mockResolvedValue({
      candidates: [],
      valAggregateScores: [],
      bestScore: 0,
      totalMetricCalls: 0,
      toJSON: () => ({}),
    });
    const warnSpy = vi.spyOn(logger, 'warn');
    const agent = new LlmAgent({name: 'agent', instruction: 'i'});
    vi.spyOn(agent, 'clone').mockReturnValue(agent);
    const sampler = makeSampler(['id1', 'id2'], ['id2', 'id3']);
    const optimizer = new GEPARootAgentPromptOptimizer(
      new GEPARootAgentPromptOptimizerConfig(),
    );

    await optimizer.optimize(agent, sampler);

    expect(warnSpy).toHaveBeenCalledWith(
      'The training and validation example UIDs overlap. This WILL cause' +
        ' aliasing issues unless each common UID refers to the same example' +
        ' in both sets.',
    );
  });

  it('warns when the initial agent has sub-agents', async () => {
    vi.mocked(engineOptimize).mockResolvedValue({
      candidates: [],
      valAggregateScores: [],
      bestScore: 0,
      totalMetricCalls: 0,
      toJSON: () => ({}),
    });
    const warnSpy = vi.spyOn(logger, 'warn');
    const child = new LlmAgent({name: 'child', instruction: 'c'});
    const agent = new LlmAgent({
      name: 'parent',
      instruction: 'i',
      subAgents: [child],
    });
    vi.spyOn(agent, 'clone').mockReturnValue(agent);
    const sampler = makeSampler(['t'], ['v']);
    const optimizer = new GEPARootAgentPromptOptimizer(
      new GEPARootAgentPromptOptimizerConfig(),
    );

    await optimizer.optimize(agent, sampler);

    expect(warnSpy).toHaveBeenCalledWith(
      'The GEPARootAgentPromptOptimizer will not optimize prompts for' +
        ' sub-agents.',
    );
  });

  it('throws when the instruction is an InstructionProvider', async () => {
    const agent = new LlmAgent({name: 'agent', instruction: () => 'dynamic'});
    const sampler = makeSampler(['t'], ['v']);
    const optimizer = new GEPARootAgentPromptOptimizer(
      new GEPARootAgentPromptOptimizerConfig(),
    );

    await expect(optimizer.optimize(agent, sampler)).rejects.toThrow(
      'requires a string instruction',
    );
  });

  it('applies configuration defaults', () => {
    const config = new GEPARootAgentPromptOptimizerConfig();
    expect(config.optimizerModel).toBe('gemini-2.5-flash');
    expect(config.maxMetricCalls).toBe(100);
    expect(config.reflectionMinibatchSize).toBe(3);
    expect(config.runDir).toBeNull();
    expect(config.modelConfiguration.thinkingConfig).toEqual({
      includeThoughts: true,
      thinkingBudget: 10240,
    });

    const custom = new GEPARootAgentPromptOptimizerConfig({
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
