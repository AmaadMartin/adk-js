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
