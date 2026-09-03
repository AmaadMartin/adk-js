/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type {FunctionCall} from '@google/genai';
import {describe, expect, it} from 'vitest';
import {
  getAllToolCalls,
  isInvocationEvents,
} from '../../src/evaluation/eval_case.js';

const TOOL_CALL_A: FunctionCall = {name: 'tool_a', args: {x: 1}};
const TOOL_CALL_B: FunctionCall = {name: 'tool_b', args: {y: 2}};

describe('eval_case', () => {
  describe('isInvocationEvents', () => {
    it('recognizes recorded events', () => {
      expect(isInvocationEvents({invocationEvents: []})).toBe(true);
    });

    it('rejects a flat trajectory', () => {
      expect(isInvocationEvents({toolUses: [TOOL_CALL_A]})).toBe(false);
    });
  });

  describe('getAllToolCalls', () => {
    it('returns nothing when there is no intermediate data', () => {
      expect(getAllToolCalls()).toEqual([]);
    });

    it('returns the flat trajectory', () => {
      expect(getAllToolCalls({toolUses: [TOOL_CALL_A, TOOL_CALL_B]})).toEqual([
        TOOL_CALL_A,
        TOOL_CALL_B,
      ]);
    });

    it('returns nothing for a trajectory that names no tool use', () => {
      expect(getAllToolCalls({})).toEqual([]);
    });

    it('collects the calls recorded across events', () => {
      const intermediateData = {
        invocationEvents: [
          {
            author: 'agent',
            content: {parts: [{functionCall: TOOL_CALL_A}, {text: 'hello'}]},
          },
          {
            author: 'agent',
            content: {parts: [{functionCall: TOOL_CALL_B}]},
          },
        ],
      };

      expect(getAllToolCalls(intermediateData)).toEqual([
        TOOL_CALL_A,
        TOOL_CALL_B,
      ]);
    });

    it('skips events that carry no content and content that carries no parts', () => {
      const intermediateData = {
        invocationEvents: [
          {author: 'agent'},
          {author: 'agent', content: {}},
          {author: 'agent', content: {parts: [{functionCall: TOOL_CALL_A}]}},
        ],
      };

      expect(getAllToolCalls(intermediateData)).toEqual([TOOL_CALL_A]);
    });
  });
});
