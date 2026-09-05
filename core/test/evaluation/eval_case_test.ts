/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  getAllToolCalls,
  IntermediateData,
  InvocationEvents,
  isInvocationEvents,
} from '@google/adk';
import type {FunctionCall} from '@google/genai';
import {describe, expect, it} from 'vitest';

const ROLL_DIE = {name: 'roll_die', args: {sides: 6}};
const CHECK_PRIME = {name: 'check_prime', args: {value: 5}};

const INTERMEDIATE_DATA: IntermediateData = {
  toolUses: [ROLL_DIE],
  toolResponses: [],
  intermediateResponses: [],
};

const INVOCATION_EVENTS: InvocationEvents = {
  invocationEvents: [
    {author: 'root', content: {parts: [{functionCall: CHECK_PRIME}]}},
    {author: 'root', content: {parts: [{text: 'thinking'}]}},
    {author: 'root'},
  ],
};

describe('isInvocationEvents', () => {
  it('tells the two intermediate data shapes apart', () => {
    expect(isInvocationEvents(INVOCATION_EVENTS)).toBe(true);
    expect(isInvocationEvents(INTERMEDIATE_DATA)).toBe(false);
  });
});

describe('getAllToolCalls', () => {
  it('returns nothing when there is no intermediate data', () => {
    expect(getAllToolCalls(undefined)).toEqual([]);
  });

  it('returns the recorded tool uses', () => {
    expect(getAllToolCalls(INTERMEDIATE_DATA)).toEqual([ROLL_DIE]);
  });

  it('collects the function calls out of invocation events', () => {
    expect(getAllToolCalls(INVOCATION_EVENTS)).toEqual([CHECK_PRIME]);
  });
});

const SEARCH_CALL: FunctionCall = {name: 'search', args: {query: 'adk'}};
const SUMMARIZE_CALL: FunctionCall = {name: 'summarize', args: {}};

/** Returns intermediate data carrying only the given tool call trajectory. */
function trajectory(...toolUses: FunctionCall[]): IntermediateData {
  return {toolUses, toolResponses: [], intermediateResponses: []};
}

describe('eval_case', () => {
  describe('getAllToolCalls', () => {
    it('returns no calls for absent intermediate data', () => {
      expect(getAllToolCalls()).toEqual([]);
    });

    it('returns no calls when the trajectory is empty', () => {
      expect(getAllToolCalls(trajectory())).toEqual([]);
    });

    it('returns the recorded trajectory in order', () => {
      expect(getAllToolCalls(trajectory(SEARCH_CALL, SUMMARIZE_CALL))).toEqual([
        SEARCH_CALL,
        SUMMARIZE_CALL,
      ]);
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
      expect(isInvocationEvents(trajectory(SEARCH_CALL))).toBe(false);
    });
  });
});
