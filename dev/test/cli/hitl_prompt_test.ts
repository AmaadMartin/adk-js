/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {createEvent, Event} from '@google/adk';
import {Part} from '@google/genai';
import {describe, expect, it} from 'vitest';
import {
  buildFunctionResponse,
  collectPendingFunctionCalls,
  isPositiveResponse,
  PendingFunctionCall,
  renderLongRunningPrompt,
} from '../../src/cli/hitl_prompt.js';

/** An event carrying the given parts, marking `longRunningToolIds` as given. */
function event(parts: Part[], longRunningToolIds?: string[]): Event {
  return createEvent({
    author: 'agent',
    content: {role: 'model', parts},
    longRunningToolIds,
  });
}

function call(
  name: string,
  args: Record<string, unknown> = {},
): PendingFunctionCall {
  return {id: 'call-1', name, args};
}

describe('collectPendingFunctionCalls', () => {
  it('returns one entry per long-running call, in event then part order', () => {
    const first = event(
      [
        {functionCall: {name: 'ask_a', id: 'a', args: {q: 1}}},
        {functionCall: {name: 'ask_b', id: 'b', args: {}}},
      ],
      ['a', 'b'],
    );
    const second = event([{functionCall: {name: 'ask_c', id: 'c'}}], ['c']);

    expect(collectPendingFunctionCalls([first, second])).toEqual([
      {id: 'a', name: 'ask_a', args: {q: 1}},
      {id: 'b', name: 'ask_b', args: {}},
      {id: 'c', name: 'ask_c', args: {}},
    ]);
  });

  it('returns nothing for an event with no longRunningToolIds', () => {
    const turn = event([{functionCall: {name: 'ask', id: 'a', args: {}}}]);

    expect(collectPendingFunctionCalls([turn])).toEqual([]);
  });

  it('returns nothing for an event whose longRunningToolIds is empty', () => {
    const turn = event([{functionCall: {name: 'ask', id: 'a'}}], []);

    expect(collectPendingFunctionCalls([turn])).toEqual([]);
  });

  it('skips a call whose id is not listed as long running', () => {
    const turn = event(
      [
        {functionCall: {name: 'quick', id: 'quick-1'}},
        {functionCall: {name: 'slow', id: 'slow-1'}},
      ],
      ['slow-1'],
    );

    expect(collectPendingFunctionCalls([turn])).toEqual([
      {id: 'slow-1', name: 'slow', args: {}},
    ]);
  });

  it('skips a part that carries no function call', () => {
    const turn = event([{text: 'thinking'}], ['a']);

    expect(collectPendingFunctionCalls([turn])).toEqual([]);
  });

  it('skips a call with no id and a call with no name', () => {
    const turn = event(
      [{functionCall: {name: 'unnamed'}}, {functionCall: {id: 'a'}}],
      ['a'],
    );

    expect(collectPendingFunctionCalls([turn])).toEqual([]);
  });
});

describe('isPositiveResponse', () => {
  it.each(['y', 'yes', 'true', 'confirm', ' YES ', 'Confirm'])(
    'accepts %s',
    (answer) => {
      expect(isPositiveResponse(answer)).toBe(true);
    },
  );

  it.each(['n', 'no', 'nope', '', ' ', 'yess'])('rejects %s', (answer) => {
    expect(isPositiveResponse(answer)).toBe(false);
  });
});

describe('renderLongRunningPrompt', () => {
  it('reports the call with its arguments', () => {
    expect(renderLongRunningPrompt(call('slow_lookup', {city: 'SF'}))).toBe(
      '[HITL] Waiting for input for slow_lookup({"city":"SF"})',
    );
  });

  it('reports a call that carries no arguments', () => {
    expect(renderLongRunningPrompt(call('slow_lookup'))).toBe(
      '[HITL] Waiting for input for slow_lookup({})',
    );
  });
});

describe('buildFunctionResponse', () => {
  it('confirms when the answer is positive', () => {
    expect(
      buildFunctionResponse(call('adk_request_confirmation'), 'yes'),
    ).toEqual({
      functionResponse: {
        id: 'call-1',
        name: 'adk_request_confirmation',
        response: {confirmed: true},
      },
    });
  });

  it('rejects when the answer is anything else', () => {
    expect(
      buildFunctionResponse(call('adk_request_confirmation'), 'later'),
    ).toEqual({
      functionResponse: {
        id: 'call-1',
        name: 'adk_request_confirmation',
        response: {confirmed: false},
      },
    });
  });

  it('carries a JSON object answer through as the response', () => {
    expect(
      buildFunctionResponse(call('adk_request_input'), '{"count": 3}'),
    ).toEqual({
      functionResponse: {
        id: 'call-1',
        name: 'adk_request_input',
        response: {count: 3},
      },
    });
  });

  it('wraps a JSON scalar answer under result', () => {
    expect(buildFunctionResponse(call('adk_request_input'), '42')).toEqual({
      functionResponse: {
        id: 'call-1',
        name: 'adk_request_input',
        response: {result: 42},
      },
    });
  });

  it('wraps a JSON array answer under result', () => {
    expect(buildFunctionResponse(call('adk_request_input'), '[1,2]')).toEqual({
      functionResponse: {
        id: 'call-1',
        name: 'adk_request_input',
        response: {result: [1, 2]},
      },
    });
  });

  it('wraps an answer that is not JSON under result', () => {
    expect(
      buildFunctionResponse(call('adk_request_input'), 'twenty one'),
    ).toEqual({
      functionResponse: {
        id: 'call-1',
        name: 'adk_request_input',
        response: {result: 'twenty one'},
      },
    });
  });

  it('wraps a JSON answer for an unrecognised long-running call', () => {
    expect(buildFunctionResponse(call('slow_lookup'), '"done"')).toEqual({
      functionResponse: {
        id: 'call-1',
        name: 'slow_lookup',
        response: {result: 'done'},
      },
    });
  });
});
