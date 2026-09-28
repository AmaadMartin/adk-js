/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type {InvocationEvent} from '@google/adk';
import type {FunctionCall} from '@google/genai';
import {describe, expect, it} from 'vitest';
import {
  getAllToolCalls,
  isInvocationEvents,
} from '../../src/evaluation/eval_case.js';

const SEARCH: FunctionCall = {name: 'search', args: {query: 'weather'}};
const BOOK: FunctionCall = {name: 'book', args: {id: 7}};

function toolCallEvent(functionCall: FunctionCall): InvocationEvent {
  return {author: 'agent', content: {parts: [{functionCall}]}};
}

describe('getAllToolCalls', () => {
  it('returns no call for absent intermediate data', () => {
    expect(getAllToolCalls()).toEqual([]);
  });

  it('returns the tool uses of a flat trajectory in order', () => {
    expect(getAllToolCalls({toolUses: [SEARCH, BOOK]})).toEqual([SEARCH, BOOK]);
  });

  it('returns no call when a flat trajectory holds none', () => {
    expect(getAllToolCalls({})).toEqual([]);
  });

  it('collects the function calls of recorded events in order', () => {
    const toolCalls = getAllToolCalls({
      invocationEvents: [
        {author: 'agent'},
        {author: 'agent', content: {}},
        {author: 'agent', content: {parts: []}},
        {author: 'agent', content: {parts: [{text: 'Let me look.'}]}},
        toolCallEvent(SEARCH),
        toolCallEvent(BOOK),
      ],
    });

    expect(toolCalls).toEqual([SEARCH, BOOK]);
  });

  it('collects several function calls authored by one event', () => {
    const toolCalls = getAllToolCalls({
      invocationEvents: [
        {
          author: 'agent',
          content: {parts: [{functionCall: SEARCH}, {functionCall: BOOK}]},
        },
      ],
    });

    expect(toolCalls).toEqual([SEARCH, BOOK]);
  });

  it('returns no call for an invocation that recorded no event', () => {
    expect(getAllToolCalls({invocationEvents: []})).toEqual([]);
  });
});

describe('isInvocationEvents', () => {
  it('recognizes recorded events', () => {
    expect(isInvocationEvents({invocationEvents: []})).toBe(true);
  });

  it('rejects a flat trajectory', () => {
    expect(isInvocationEvents({toolUses: []})).toBe(false);
  });
});
