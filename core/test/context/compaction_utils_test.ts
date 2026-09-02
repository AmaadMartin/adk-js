/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {createEvent, createEventActions, Event} from '@google/adk';
import {describe, expect, it} from 'vitest';

import {longestSelfContainedPrefix} from '../../src/context/compaction_utils.js';

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
