/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Ported from adk-python
 * `tests/unittests/optimization/gepa_root_agent_prompt_optimizer_test.py` on
 * branch `main`. The `it` strings keep the Python test names so the two suites
 * stay greppable against each other.
 */

import {
  AGENT_PROMPT_NAME,
  AgentGepaAdapter,
  GEPARootAgentPromptOptimizer,
  LlmAgent,
  type EvaluationBatch,
} from '@google/adk';
import {describe, expect, it, vi} from 'vitest';
import {
  collectWarnings,
  FakeGepaEngine,
  onlyOptimizeCall,
  RecordingSampler,
  runResult,
} from './gepa_test_utils.js';

const TRAIN_IDS = ['train1', 'train2'];
const VALIDATION_IDS = ['val1', 'val2'];

function createAgent(): LlmAgent {
  return new LlmAgent({
    name: 'support_agent',
    instruction: 'Initial instruction',
  });
}

describe('AgentGepaAdapter', () => {
  it('test_adapter_init', async () => {
    const sampler = new RecordingSampler({
      trainIds: TRAIN_IDS,
      validationIds: VALIDATION_IDS,
      result: {scores: {train1: 1, train2: 1, val1: 1, val2: 1}},
    });
    const adapter = new AgentGepaAdapter({
      initialAgent: createAgent(),
      sampler,
    });

    await adapter.evaluate(TRAIN_IDS, {[AGENT_PROMPT_NAME]: 'Prompt'});
    await adapter.evaluate(VALIDATION_IDS, {[AGENT_PROMPT_NAME]: 'Prompt'});

    expect(sampler.calls.map((call) => call.exampleSet)).toEqual([
      'train',
      'validation',
    ]);
  });

  it('test_adapter_evaluate_train', async () => {
    const agent = createAgent();
    const clone = vi.spyOn(agent, 'clone');
    const sampler = new RecordingSampler({
      trainIds: TRAIN_IDS,
      validationIds: VALIDATION_IDS,
      result: {scores: {train1: 0.8}, data: {train1: {output: 'result'}}},
    });
    const adapter = new AgentGepaAdapter({initialAgent: agent, sampler});

    const evalBatch = await adapter.evaluate(
      ['train1'],
      {[AGENT_PROMPT_NAME]: 'New prompt'},
      true,
    );

    expect(clone).toHaveBeenCalledWith({instruction: 'New prompt'});
    expect(sampler.calls).toHaveLength(1);
    expect(sampler.calls[0].exampleSet).toBe('train');
    expect(sampler.calls[0].batch).toEqual(['train1']);
    expect(sampler.calls[0].captureFullEvalData).toBe(true);
    expect(sampler.calls[0].candidate.instruction).toBe('New prompt');
    expect(evalBatch.scores).toEqual([0.8]);
    expect(evalBatch.trajectories).toEqual([{output: 'result'}]);
  });

  it('test_adapter_evaluate_validation', async () => {
    const sampler = new RecordingSampler({
      trainIds: TRAIN_IDS,
      validationIds: VALIDATION_IDS,
      result: {scores: {val1: 0.5}, data: {}},
    });
    const adapter = new AgentGepaAdapter({
      initialAgent: createAgent(),
      sampler,
    });

    const evalBatch = await adapter.evaluate(['val1'], {
      [AGENT_PROMPT_NAME]: 'New prompt',
    });

    expect(sampler.calls).toHaveLength(1);
    expect(sampler.calls[0].exampleSet).toBe('validation');
    expect(sampler.calls[0].batch).toEqual(['val1']);
    expect(sampler.calls[0].captureFullEvalData).toBe(false);
    expect(evalBatch.trajectories).toEqual([{}]);
  });

  it('test_adapter_evaluate_missing_example_id_in_scores', async () => {
    const sampler = new RecordingSampler({
      trainIds: TRAIN_IDS,
      validationIds: VALIDATION_IDS,
      result: {scores: {train1: 0.8}, data: {train1: {output: 'result'}}},
    });
    const adapter = new AgentGepaAdapter({
      initialAgent: createAgent(),
      sampler,
    });

    let evalBatch: EvaluationBatch | undefined;
    const warnings = await collectWarnings(async () => {
      evalBatch = await adapter.evaluate(TRAIN_IDS, {
        [AGENT_PROMPT_NAME]: 'New prompt',
      });
    });

    expect(warnings).toContain(
      'Example train2 missing from sampling result; scoring it 0.',
    );
    expect(evalBatch?.scores).toEqual([0.8, 0]);
    expect(evalBatch?.trajectories).toEqual([{output: 'result'}, {}]);
  });

  it('test_adapter_make_reflective_dataset', () => {
    const sampler = new RecordingSampler({
      trainIds: TRAIN_IDS,
      validationIds: VALIDATION_IDS,
      result: {scores: {}},
    });
    const adapter = new AgentGepaAdapter({
      initialAgent: createAgent(),
      sampler,
    });

    const dataset = adapter.makeReflectiveDataset(
      {[AGENT_PROMPT_NAME]: 'Prompt'},
      {scores: [0.9, 0.1], trajectories: [{t: 1}, {t: 2}]},
      ['component1'],
    );

    expect(Object.keys(dataset)).toEqual(['component1']);
    expect(dataset['component1']).toEqual([
      {agent_prompt: 'Prompt', score: 0.9, eval_data: {t: 1}},
      {agent_prompt: 'Prompt', score: 0.1, eval_data: {t: 2}},
    ]);
  });

  it('test_adapter_rejects_missing_trajectories', () => {
    const sampler = new RecordingSampler({
      trainIds: TRAIN_IDS,
      validationIds: VALIDATION_IDS,
      result: {scores: {}},
    });
    const adapter = new AgentGepaAdapter({
      initialAgent: createAgent(),
      sampler,
    });

    expect(() => adapter.makeReflectiveDataset({}, {scores: []}, [])).toThrow(
      /without captured trajectories/,
    );
  });
});

describe('GEPARootAgentPromptOptimizer', () => {
  it('test_optimize', async () => {
    const agent = createAgent();
    const clone = vi.spyOn(agent, 'clone');
    const sampler = new RecordingSampler({
      trainIds: TRAIN_IDS,
      validationIds: VALIDATION_IDS,
      result: {scores: {}},
    });
    const engine = new FakeGepaEngine(
      runResult([{[AGENT_PROMPT_NAME]: 'Optimized instruction'}], [0.95], {
        full: 'result',
      }),
    );

    const result = await new GEPARootAgentPromptOptimizer({engine}).optimize({
      initialAgent: agent,
      sampler,
    });

    const call = onlyOptimizeCall(engine);
    expect(call.seedCandidate).toEqual({
      [AGENT_PROMPT_NAME]: 'Initial instruction',
    });
    expect(call.trainset).toEqual(TRAIN_IDS);
    expect(call.valset).toEqual(VALIDATION_IDS);
    expect(result.optimizedAgents).toHaveLength(1);
    expect(result.optimizedAgents[0].overallScore).toBe(0.95);
    expect(clone).toHaveBeenCalledWith({
      instruction: 'Optimized instruction',
    });
    expect(result.optimizedAgents[0].optimizedAgent.instruction).toBe(
      'Optimized instruction',
    );
    expect(result.gepaResult).toEqual({full: 'result'});
  });

  it('test_optimize_logs_warning_on_overlapping_ids', async () => {
    const sampler = new RecordingSampler({
      trainIds: ['id1', 'id2'],
      validationIds: ['id2', 'id3'],
      result: {scores: {}},
    });
    const engine = new FakeGepaEngine(runResult([], []));
    const optimizer = new GEPARootAgentPromptOptimizer({engine});

    const warnings = await collectWarnings(async () => {
      await optimizer.optimize({initialAgent: createAgent(), sampler});
    });

    expect(warnings).toContain(
      'The training and validation example UIDs overlap. This WILL cause' +
        ' aliasing issues unless each common UID refers to the same example' +
        ' in both sets.',
    );
  });
});
