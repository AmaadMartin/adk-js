/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  AgentWithScores,
  InputValidationError,
  LlmAgent,
  OptimizerResult,
  parseAgentWithScores,
  parseOptimizerResult,
  parseSamplingResult,
  parseUnstructuredSamplingResult,
  SamplingResult,
  UnstructuredSamplingResult,
} from '@google/adk';
import {beforeEach, describe, expect, it} from 'vitest';

/** An `AgentWithScores` subtype, of the kind the reference tells optimizers to build. */
interface AgentWithCustomMetrics extends AgentWithScores {
  toolCallAccuracy: number;
}

describe('optimization data types', () => {
  let agent: LlmAgent;

  beforeEach(() => {
    agent = new LlmAgent({name: 'optimizer_candidate'});
  });

  describe('parseSamplingResult', () => {
    it('accepts an empty score map', () => {
      expect(parseSamplingResult({scores: {}})).toEqual({scores: {}});
    });

    it('accepts a populated score map', () => {
      const result = parseSamplingResult({scores: {'ex-1': 0.8, 'ex-2': 0}});

      expect(result.scores).toEqual({'ex-1': 0.8, 'ex-2': 0});
    });

    it('keeps a key the schema does not declare', () => {
      const result = parseSamplingResult({scores: {}, samplerVersion: 3});

      expect(result).toEqual({scores: {}, samplerVersion: 3});
    });

    it('throws when scores is missing', () => {
      expect(() => parseSamplingResult({})).toThrow(InputValidationError);
      expect(() => parseSamplingResult({})).toThrow(/scores/);
    });

    it('throws when scores is an array', () => {
      expect(() => parseSamplingResult({scores: [0.8]})).toThrow(/scores/);
    });

    it('throws when a score is not a number', () => {
      expect(() => parseSamplingResult({scores: {'ex-1': null}})).toThrow(
        /scores/,
      );
    });

    it('does not coerce a numeric string', () => {
      expect(() => parseSamplingResult({scores: {'ex-1': '0.5'}})).toThrow(
        InputValidationError,
      );
    });
  });

  describe('parseUnstructuredSamplingResult', () => {
    it('reads an absent data field as undefined', () => {
      const result = parseUnstructuredSamplingResult({scores: {val1: 0.5}});

      expect(result.data).toBeUndefined();
    });

    it('reads an explicitly null data field as undefined', () => {
      const result = parseUnstructuredSamplingResult({
        scores: {val1: 0.5},
        data: null,
      });

      expect(result.data).toBeUndefined();
    });

    it('accepts an empty data map', () => {
      const result = parseUnstructuredSamplingResult({
        scores: {val1: 0.5},
        data: {},
      });

      expect(result.data).toEqual({});
    });

    it('accepts a populated data map', () => {
      const result = parseUnstructuredSamplingResult({
        scores: {'example-1': 0.8},
        data: {'example-1': {trajectory: ['roll_die', 'check_prime']}},
      });

      expect(result.data).toEqual({
        'example-1': {trajectory: ['roll_die', 'check_prime']},
      });
    });

    it('throws when data is not an object', () => {
      expect(() =>
        parseUnstructuredSamplingResult({scores: {}, data: 5}),
      ).toThrow(/data/);
    });

    it('throws when a data entry is not an object', () => {
      expect(() =>
        parseUnstructuredSamplingResult({scores: {}, data: {'ex-1': 1}}),
      ).toThrow(/data/);
    });

    it('still validates the inherited scores field', () => {
      expect(() => parseUnstructuredSamplingResult({data: {}})).toThrow(
        /scores/,
      );
    });
  });

  describe('parseAgentWithScores', () => {
    it('returns the same agent instance it was given', () => {
      const parsed = parseAgentWithScores({optimizedAgent: agent});

      expect(parsed.optimizedAgent).toBe(agent);
    });

    it('reads an absent overallScore as undefined', () => {
      const parsed = parseAgentWithScores({optimizedAgent: agent});

      expect(parsed.overallScore).toBeUndefined();
    });

    it('reads an explicitly null overallScore as undefined', () => {
      const parsed = parseAgentWithScores({
        optimizedAgent: agent,
        overallScore: null,
      });

      expect(parsed.overallScore).toBeUndefined();
    });

    it('keeps an overallScore of zero', () => {
      const parsed = parseAgentWithScores({
        optimizedAgent: agent,
        overallScore: 0,
      });

      expect(parsed.overallScore).toBe(0);
    });

    it('keeps a custom metric that the schema does not declare', () => {
      const parsed = parseAgentWithScores({
        optimizedAgent: agent,
        overallScore: 0.8,
        toolCallAccuracy: 0.9,
      });

      expect(parsed).toMatchObject({overallScore: 0.8, toolCallAccuracy: 0.9});
    });

    it('throws when optimizedAgent is missing', () => {
      expect(() => parseAgentWithScores({})).toThrow(InputValidationError);
      expect(() => parseAgentWithScores({})).toThrow(/optimizedAgent/);
    });

    it('throws when optimizedAgent is a plain object', () => {
      expect(() =>
        parseAgentWithScores({optimizedAgent: {name: 'not_an_agent'}}),
      ).toThrow(/optimizedAgent/);
    });

    it('throws when optimizedAgent is not an object', () => {
      expect(() => parseAgentWithScores({optimizedAgent: 'agent'})).toThrow(
        /optimizedAgent/,
      );
    });

    it('throws when overallScore is not a number', () => {
      expect(() =>
        parseAgentWithScores({optimizedAgent: agent, overallScore: 'high'}),
      ).toThrow(/overallScore/);
    });
  });

  describe('parseOptimizerResult', () => {
    it('accepts an empty Pareto front', () => {
      expect(parseOptimizerResult({optimizedAgents: []})).toEqual({
        optimizedAgents: [],
      });
    });

    it('accepts a one-element Pareto front', () => {
      const parsed = parseOptimizerResult({
        optimizedAgents: [{optimizedAgent: agent, overallScore: 0.8}],
      });

      expect(parsed.optimizedAgents).toHaveLength(1);
      expect(parsed.optimizedAgents[0].optimizedAgent).toBe(agent);
    });

    it('throws when optimizedAgents is missing', () => {
      expect(() => parseOptimizerResult({})).toThrow(InputValidationError);
      expect(() => parseOptimizerResult({})).toThrow(/optimizedAgents/);
    });

    it('throws when optimizedAgents is not an array', () => {
      expect(() => parseOptimizerResult({optimizedAgents: {}})).toThrow(
        /optimizedAgents/,
      );
    });

    it('throws naming the offending field of an invalid element', () => {
      expect(() =>
        parseOptimizerResult({optimizedAgents: [{overallScore: 0.8}]}),
      ).toThrow(/optimizedAgent/);
    });
  });

  describe('type parameters', () => {
    it('carries a subtype through an OptimizerResult', () => {
      const scored: AgentWithCustomMetrics = {
        optimizedAgent: agent,
        overallScore: 0.8,
        toolCallAccuracy: 0.9,
      };
      const front: OptimizerResult<AgentWithCustomMetrics> = {
        optimizedAgents: [scored],
      };
      const bare: OptimizerResult = front;

      expect(bare.optimizedAgents[0]).toBe(scored);
    });

    it('accepts an UnstructuredSamplingResult where a SamplingResult is wanted', () => {
      const unstructured: UnstructuredSamplingResult = {
        scores: {'example-1': 0.8},
        data: {'example-1': {trajectory: ['roll_die']}},
      };
      const base: SamplingResult = unstructured;

      expect(base.scores).toEqual({'example-1': 0.8});
    });
  });
});
