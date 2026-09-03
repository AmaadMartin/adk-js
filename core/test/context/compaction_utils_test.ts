/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {createEvent, createEventActions, Event} from '@google/adk';
import {describe, expect, it} from 'vitest';

import {
  longestSelfContainedPrefix,
  recoverCompactedFunctionCalls,
} from '../../src/context/compaction_utils.js';

function text(author: string, body: string): Event {
  return createEvent({
    invocationId: 'inv1',
    author,
    content: {
      role: author === 'user' ? 'user' : 'model',
      parts: [{text: body}],
    },
  });
}

function call(id: string, name = 'lookup'): Event {
  return createEvent({
    invocationId: 'inv1',
    author: 'agent',
    content: {
      role: 'model',
      parts: [{functionCall: {id, name, args: {}}}],
    },
  });
}

function response(id: string, name = 'lookup'): Event {
  return createEvent({
    invocationId: 'inv1',
    author: 'user',
    content: {
      role: 'user',
      parts: [{functionResponse: {id, name, response: {ok: true}}}],
    },
  });
}

function bodies(events: Event[]): string[] {
  return events.map((e) => {
    const part = e.content?.parts?.[0];
    return (
      part?.text ??
      part?.functionCall?.id ??
      part?.functionResponse?.id ??
      e.author ??
      ''
    );
  });
}

describe('longestSelfContainedPrefix', () => {
  it('keeps a window that opens nothing', () => {
    const events = [text('user', 'hi'), text('agent', 'hello')];

    expect(longestSelfContainedPrefix(events)).toEqual(events);
  });

  it('keeps an empty window empty', () => {
    expect(longestSelfContainedPrefix([])).toEqual([]);
  });

  it('stops before a call that nothing answers', () => {
    const events = [text('user', 'hi'), text('agent', 'hello'), call('fc1')];

    expect(bodies(longestSelfContainedPrefix(events))).toEqual(['hi', 'hello']);
  });

  it('keeps a call once its response arrives', () => {
    const events = [
      text('user', 'hi'),
      call('fc1'),
      response('fc1'),
      text('agent', 'done'),
    ];

    expect(longestSelfContainedPrefix(events)).toEqual(events);
  });

  it('stops before the first call left open, not the last', () => {
    const events = [
      call('fc1'),
      response('fc1'),
      call('fc2'),
      text('agent', 'thinking'),
      call('fc3'),
      response('fc3'),
    ];

    expect(bodies(longestSelfContainedPrefix(events))).toEqual(['fc1', 'fc1']);
  });

  it('leaves out a call that only an earlier response could close', () => {
    // A response closes an obligation an earlier event opened, never a later
    // one, so the call stays outside the prefix.
    const events = [response('fc1'), call('fc1')];

    expect(bodies(longestSelfContainedPrefix(events))).toEqual(['fc1']);
    expect(longestSelfContainedPrefix(events)).toHaveLength(1);
  });

  it('stops before a pending tool confirmation', () => {
    const events = [
      text('user', 'delete it'),
      createEvent({
        invocationId: 'inv1',
        author: 'agent',
        actions: createEventActions({
          requestedToolConfirmations: {
            fc1: {hint: 'confirm the deletion', confirmed: false},
          },
        }),
      }),
    ];

    expect(bodies(longestSelfContainedPrefix(events))).toEqual(['delete it']);
  });

  it('stops before a pending auth request', () => {
    const events = [
      text('user', 'read my calendar'),
      createEvent({
        invocationId: 'inv1',
        author: 'agent',
        actions: createEventActions({
          requestedAuthConfigs: {
            fc1: {
              credentialKey: 'x-key',
              authScheme: {type: 'apiKey', in: 'header', name: 'x-key'},
            },
          },
        }),
      }),
    ];

    expect(bodies(longestSelfContainedPrefix(events))).toEqual([
      'read my calendar',
    ]);
  });

  it('ignores a call that carries no id', () => {
    const events = [
      text('user', 'hi'),
      createEvent({
        invocationId: 'inv1',
        author: 'agent',
        content: {
          role: 'model',
          parts: [{functionCall: {name: 'lookup', args: {}}}],
        },
      }),
    ];

    expect(longestSelfContainedPrefix(events)).toEqual(events);
  });

  it('ignores a response that carries no id', () => {
    const events = [
      call('fc1'),
      createEvent({
        invocationId: 'inv1',
        author: 'user',
        content: {
          role: 'user',
          parts: [{functionResponse: {name: 'lookup', response: {ok: true}}}],
        },
      }),
    ];

    expect(longestSelfContainedPrefix(events)).toEqual([]);
  });
});

/**
 * Builds a model event that calls `roll_die` under the given `adk-` ids.
 */
function createCallEvent(ids: string[], timestamp = 1000): Event {
  return createEvent({
    author: 'agent',
    timestamp,
    content: {
      role: 'model',
      parts: ids.map((id) => ({
        functionCall: {id, name: 'roll_die', args: {sides: 6}},
      })),
    },
  });
}

/**
 * Builds a user event that answers `roll_die` for the given `adk-` id.
 */
function createResponseEvent(
  id: string,
  result: string,
  timestamp = 2000,
): Event {
  return createEvent({
    author: 'user',
    timestamp,
    content: {
      role: 'user',
      parts: [{functionResponse: {id, name: 'roll_die', response: {result}}}],
    },
  });
}

describe('recoverCompactedFunctionCalls', () => {
  it('re-injects a missing call right before the surviving response', () => {
    const summary = createEvent({
      author: 'user',
      timestamp: 1500,
      content: {role: 'user', parts: [{text: '[Previous Context Summary]'}]},
    });
    const callEvent = createCallEvent(['adk-1']);
    const responseEvent = createResponseEvent('adk-1', 'four', 3000);

    const recovered = recoverCompactedFunctionCalls(
      [summary, responseEvent],
      [callEvent, summary, responseEvent],
    );

    expect(recovered).toEqual([summary, callEvent, responseEvent]);
  });

  it('returns the same array when every response has its call', () => {
    const callEvent = createCallEvent(['adk-1']);
    const responseEvent = createResponseEvent('adk-1', 'four');
    const events = [callEvent, responseEvent];

    expect(recoverCompactedFunctionCalls(events, events)).toBe(events);
  });

  it('recovers the latest response of a compacted sibling', () => {
    const parallelCall = createCallEvent(['adk-lr1', 'adk-lr2'], 1000);
    const lr2Placeholder = createResponseEvent('adk-lr2', 'pending', 1100);
    const lr2Result = createResponseEvent('adk-lr2', 'six', 1200);
    const summary = createEvent({
      author: 'user',
      timestamp: 1500,
      content: {role: 'user', parts: [{text: '[Previous Context Summary]'}]},
    });
    const lr1Result = createResponseEvent('adk-lr1', 'two', 3000);
    const sourceEvents = [
      parallelCall,
      lr2Placeholder,
      lr2Result,
      summary,
      lr1Result,
    ];

    const recovered = recoverCompactedFunctionCalls(
      [summary, lr1Result],
      sourceEvents,
    );

    expect(recovered).toEqual([summary, parallelCall, lr2Result, lr1Result]);
  });

  it('leaves an orphan alone when the source has no matching call', () => {
    const responseEvent = createResponseEvent('adk-gone', 'four');
    const events = [responseEvent];

    expect(recoverCompactedFunctionCalls(events, events)).toBe(events);
  });

  it('ignores a call and a response that carry no id', () => {
    const idlessCall = createEvent({
      author: 'agent',
      timestamp: 1000,
      content: {
        role: 'model',
        parts: [{functionCall: {name: 'roll_die', args: {}}}],
      },
    });
    const idlessResponse = createEvent({
      author: 'user',
      timestamp: 2000,
      content: {
        role: 'user',
        parts: [{functionResponse: {name: 'roll_die', response: {}}}],
      },
    });
    const events = [idlessCall, idlessResponse];

    expect(recoverCompactedFunctionCalls(events, events)).toBe(events);
  });

  it('skips a source response with no id when picking the latest', () => {
    const parallelCall = createCallEvent(['adk-lr1', 'adk-lr2'], 1000);
    const idlessResponse = createEvent({
      author: 'user',
      timestamp: 1100,
      content: {
        role: 'user',
        parts: [{functionResponse: {name: 'roll_die', response: {}}}],
      },
    });
    const lr2Result = createResponseEvent('adk-lr2', 'six', 1200);
    const lr1Result = createResponseEvent('adk-lr1', 'two', 3000);

    const recovered = recoverCompactedFunctionCalls(
      [lr1Result],
      [parallelCall, idlessResponse, lr2Result, lr1Result],
    );

    expect(recovered).toEqual([parallelCall, lr2Result, lr1Result]);
  });

  it('leaves a sibling out when the source never answered it', () => {
    const parallelCall = createCallEvent(['adk-lr1', 'adk-lr2'], 1000);
    const lr1Result = createResponseEvent('adk-lr1', 'two', 3000);

    const recovered = recoverCompactedFunctionCalls(
      [lr1Result],
      [parallelCall, lr1Result],
    );

    expect(recovered).toEqual([parallelCall, lr1Result]);
  });

  it('re-injects one call event once for two surviving responses', () => {
    const parallelCall = createCallEvent(['adk-lr1', 'adk-lr2'], 1000);
    const lr1Result = createResponseEvent('adk-lr1', 'two', 3000);
    const lr2Result = createResponseEvent('adk-lr2', 'six', 3100);

    const recovered = recoverCompactedFunctionCalls(
      [lr1Result, lr2Result],
      [parallelCall, lr1Result, lr2Result],
    );

    expect(recovered).toEqual([parallelCall, lr1Result, lr2Result]);
  });

  it('keeps the first source event that carries an orphaned call', () => {
    const firstCall = createCallEvent(['adk-1'], 1000);
    const laterCall = createCallEvent(['adk-1'], 1100);
    const responseEvent = createResponseEvent('adk-1', 'four', 3000);

    const recovered = recoverCompactedFunctionCalls(
      [responseEvent],
      [firstCall, laterCall, responseEvent],
    );

    expect(recovered[0]).toBe(firstCall);
  });
});
