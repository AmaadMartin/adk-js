/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Event} from '@google/adk';
import {describe, expect, it} from 'vitest';
import {
  buildFunctionResponse,
  collectPendingFunctionCalls,
  isPositiveResponse,
  PendingFunctionCall,
  renderFunctionCallPrompt,
} from '../../src/cli/hitl_prompt.js';

/** An event carrying the given parts, marking `longRunningToolIds` as given. */
function event(parts: unknown[], longRunningToolIds?: string[]): Event {
  return {
    author: 'agent',
    content: {role: 'model', parts},
    longRunningToolIds,
  } as Event;
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

describe('renderFunctionCallPrompt', () => {
  it('prints the message of an input request', () => {
    expect(
      renderFunctionCallPrompt(
        call('adk_request_input', {message: 'Enter a number:'}),
      ),
    ).toBe('[HITL input] Enter a number:');
  });

  it('names an input request that carries no message', () => {
    expect(renderFunctionCallPrompt(call('adk_request_input'))).toBe(
      '[HITL input] Input requested',
    );
  });

  it('names an input request whose message is empty', () => {
    expect(
      renderFunctionCallPrompt(call('adk_request_input', {message: ''})),
    ).toBe('[HITL input] Input requested');
  });

  it('adds the schema of an input request that declares one', () => {
    expect(
      renderFunctionCallPrompt(
        call('adk_request_input', {
          message: 'How many?',
          response_schema: {type: 'integer'},
        }),
      ),
    ).toBe('[HITL input] How many?\n  Schema: {"type":"integer"}');
  });

  it('prints the hint of a confirmation request', () => {
    expect(
      renderFunctionCallPrompt(
        call('adk_request_confirmation', {
          toolConfirmation: {hint: 'This reads patient records.'},
        }),
      ),
    ).toBe(
      '[HITL confirm] This reads patient records.\n' +
        '  Type "yes" to confirm, anything else to reject.',
    );
  });

  it('names the guarded tool when the confirmation carries no hint', () => {
    expect(
      renderFunctionCallPrompt(
        call('adk_request_confirmation', {
          toolConfirmation: {hint: ''},
          originalFunctionCall: {name: 'find_orders'},
        }),
      ),
    ).toBe(
      '[HITL confirm] Confirm find_orders?\n' +
        '  Type "yes" to confirm, anything else to reject.',
    );
  });

  it('falls back to an unknown tool name', () => {
    expect(renderFunctionCallPrompt(call('adk_request_confirmation'))).toBe(
      '[HITL confirm] Confirm unknown?\n' +
        '  Type "yes" to confirm, anything else to reject.',
    );
  });

  it('reports any other long-running call with its arguments', () => {
    expect(renderFunctionCallPrompt(call('slow_lookup', {city: 'SF'}))).toBe(
      '[HITL] Waiting for input for slow_lookup({"city":"SF"})',
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
