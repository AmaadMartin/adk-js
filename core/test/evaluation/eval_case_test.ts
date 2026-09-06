/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {getAllToolCalls, type InvocationEvents} from '@google/adk';
import type {FunctionCall} from '@google/genai';
import {describe, expect, it} from 'vitest';
import {isInvocationEvents} from '../../src/evaluation/eval_case.js';

const SEARCH_CALL: FunctionCall = {name: 'search', args: {query: 'adk'}};
const SUMMARIZE_CALL: FunctionCall = {name: 'summarize', args: {}};

describe('eval_case', () => {
  describe('getAllToolCalls', () => {
    it('returns no calls for absent intermediate data', () => {
      expect(getAllToolCalls()).toEqual([]);
    });

    it('returns no calls when the trajectory is empty', () => {
      expect(getAllToolCalls({})).toEqual([]);
    });

    it('returns the recorded trajectory in order', () => {
      expect(
        getAllToolCalls({toolUses: [SEARCH_CALL, SUMMARIZE_CALL]}),
      ).toEqual([SEARCH_CALL, SUMMARIZE_CALL]);
    });

    it('flattens the calls across events and parts, in order', () => {
      const intermediateData: InvocationEvents = {
        invocationEvents: [
          {author: 'user'},
          {author: 'agent', content: {}},
          {author: 'agent', content: {parts: []}},
          {
            author: 'agent',
            content: {
              parts: [
                {text: 'searching'},
                {functionCall: SEARCH_CALL},
                {functionCall: SUMMARIZE_CALL},
              ],
            },
          },
        ],
      };

      expect(getAllToolCalls(intermediateData)).toEqual([
        SEARCH_CALL,
        SUMMARIZE_CALL,
      ]);
    });
  });

  describe('isInvocationEvents', () => {
    it('accepts the events shape', () => {
      expect(isInvocationEvents({invocationEvents: []})).toBe(true);
    });

    it('rejects the trajectory shape', () => {
      expect(isInvocationEvents({toolUses: [SEARCH_CALL]})).toBe(false);
    });
  });
});
