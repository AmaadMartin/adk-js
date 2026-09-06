/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  AgentWithScores,
  LlmAgent,
  OptimizerResult,
  SamplingResult,
  UnstructuredSamplingResult,
} from '@google/adk';
import {describe, expect, it} from 'vitest';

/**
 * The module declares types only, so these tests drive them the way a sampler
 * and an optimizer will: through the two functions below, whose parameter
 * types are the contract under test. A change that breaks the inheritance
 * chain, the optional fields or the type parameter fails `npm run ts:check`
 * here rather than in a consumer ported later.
 */

/** Stands in for the optimizer side, which reads any `SamplingResult`. */
function bestExampleUid(result: SamplingResult): string | undefined {
  const ranked = Object.entries(result.scores).sort((a, b) => b[1] - a[1]);
  return ranked[0]?.[0];
}

/** Stands in for a caller that reads the Pareto front. */
function agentNames(result: OptimizerResult): string[] {
  return result.optimizedAgents.map((agent) => agent.optimizedAgent.name);
}

function newAgent(name: string): LlmAgent {
  return new LlmAgent({name});
}

describe('SamplingResult', () => {
  it('ranks a populated scores map', () => {
    const result: SamplingResult = {scores: {train1: 0.8, train2: 0.0}};

    expect(bestExampleUid(result)).toBe('train1');
  });

  it('allows an empty scores map', () => {
    expect(bestExampleUid({scores: {}})).toBeUndefined();
  });
});

describe('UnstructuredSamplingResult', () => {
  it('is accepted wherever a SamplingResult is', () => {
    const result: UnstructuredSamplingResult = {
      scores: {train1: 0.8, train2: 0.9},
      data: {train1: {output: 'result'}},
    };

    expect(bestExampleUid(result)).toBe('train2');
  });

  it('leaves data optional', () => {
    const result: UnstructuredSamplingResult = {scores: {val1: 0.5}};

    expect(result.data).toBeUndefined();
  });

  it('accepts the shape gepa_root_agent_optimizer_test.py builds', () => {
    const result: UnstructuredSamplingResult = {
      scores: {train1: 0.8},
      data: {train1: {output: 'result'}},
    };

    expect(result.data?.['train1']).toEqual({output: 'result'});
  });

  it('accepts the shape local_eval_sampler_test.py asserts', () => {
    const result: UnstructuredSamplingResult = {
      scores: {t1: 1.0, t2: 0.0},
      data: {t1: {}, t2: {}},
    };

    expect(result.scores).toEqual({t1: 1.0, t2: 0.0});
    expect(result.data).toEqual({t1: {}, t2: {}});
  });
});

describe('AgentWithScores', () => {
  it('holds the agent instance and leaves overallScore optional', () => {
    const agent = newAgent('tuned_agent');
    const scored: AgentWithScores = {optimizedAgent: agent};

    expect(scored.optimizedAgent).toBe(agent);
    expect(scored.overallScore).toBeUndefined();
  });
});

describe('OptimizerResult', () => {
  it('reads an unparameterized front through the default type argument', () => {
    const front: OptimizerResult = {
      optimizedAgents: [
        {optimizedAgent: newAgent('first'), overallScore: 0.9},
        {optimizedAgent: newAgent('second'), overallScore: 0.4},
      ],
    };

    expect(agentNames(front)).toEqual(['first', 'second']);
  });

  it('allows an empty Pareto front', () => {
    expect(agentNames({optimizedAgents: []})).toEqual([]);
  });

  it('carries a subtype and its extra fields', () => {
    interface AgentWithLatency extends AgentWithScores {
      medianLatencyMs: number;
    }
    const front: OptimizerResult<AgentWithLatency> = {
      optimizedAgents: [
        {
          optimizedAgent: newAgent('fast_agent'),
          overallScore: 0.7,
          medianLatencyMs: 240,
        },
      ],
    };

    expect(front.optimizedAgents[0].medianLatencyMs).toBe(240);
    expect(agentNames(front)).toEqual(['fast_agent']);
  });
});
