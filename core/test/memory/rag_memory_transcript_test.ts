/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {createEvent, createSession} from '@google/adk';
import {describe, expect, it} from 'vitest';
import {
  buildSourceDisplayName,
  mergeEventLists,
  parseSourceDisplayName,
  parseTranscriptEvents,
  serializeSessionTranscript,
  SOURCE_DISPLAY_NAME_PREFIX,
  TranscriptEvent,
} from '../../src/memory/rag_memory_transcript.js';

function event(timestamp: number): TranscriptEvent {
  return {author: 'user', timestamp, text: `text-${timestamp}`};
}

function timestampsOf(eventLists: TranscriptEvent[][]): number[][] {
  return eventLists.map((events) => events.map((e) => e.timestamp));
}

describe('buildSourceDisplayName / parseSourceDisplayName', () => {
  it('round-trips identifiers containing the separator', () => {
    const identity = {
      appName: 'demo.app',
      userId: 'alice.smith',
      sessionId: 'session.secret',
    };

    const displayName = buildSourceDisplayName(identity);

    expect(displayName.startsWith(SOURCE_DISPLAY_NAME_PREFIX)).toBe(true);
    expect(displayName).not.toBe('demo.app.alice.smith.session.secret');
    expect(parseSourceDisplayName(displayName)).toEqual(identity);
  });

  it('round-trips identifiers containing url-unsafe and non-ascii characters', () => {
    const identity = {
      appName: 'a/b+c',
      userId: 'ünïcödé 名前',
      sessionId: '',
    };

    expect(parseSourceDisplayName(buildSourceDisplayName(identity))).toEqual(
      identity,
    );
  });

  it('rejects a prefixed name that does not have exactly three parts', () => {
    const twoParts = SOURCE_DISPLAY_NAME_PREFIX + 'ZGVtbw.YWxpY2U';
    const fourParts = SOURCE_DISPLAY_NAME_PREFIX + 'ZGVtbw.YWxpY2U.cw.eA';

    expect(parseSourceDisplayName(twoParts)).toBeUndefined();
    expect(parseSourceDisplayName(fourParts)).toBeUndefined();
  });

  it('rejects a prefixed part that is outside the base64url alphabet', () => {
    const name = SOURCE_DISPLAY_NAME_PREFIX + 'ZGVtbw.!.cw';

    expect(parseSourceDisplayName(name)).toBeUndefined();
  });

  it('rejects a prefixed part that is padded or non-canonical', () => {
    const padded = SOURCE_DISPLAY_NAME_PREFIX + 'ZGVtbw==.YWxpY2U.cw';
    const nonCanonical = SOURCE_DISPLAY_NAME_PREFIX + 'ZGVtbw.YWxpY2U.cx';

    expect(parseSourceDisplayName(padded)).toBeUndefined();
    expect(parseSourceDisplayName(nonCanonical)).toBeUndefined();
  });

  it('rejects a prefixed part that does not decode as utf-8', () => {
    // '_w' is base64url for the byte 0xff, which starts no utf-8 sequence.
    const name = SOURCE_DISPLAY_NAME_PREFIX + 'ZGVtbw.YWxpY2U._w';

    expect(parseSourceDisplayName(name)).toBeUndefined();
  });

  it('accepts a legacy name with exactly three parts', () => {
    expect(parseSourceDisplayName('demo.alice.legacy_session')).toEqual({
      appName: 'demo',
      userId: 'alice',
      sessionId: 'legacy_session',
    });
  });

  it('rejects a legacy name with two or four parts', () => {
    expect(parseSourceDisplayName('demo.alice')).toBeUndefined();
    expect(parseSourceDisplayName('demo.alice.smith.secret')).toBeUndefined();
  });
});

describe('serializeSessionTranscript', () => {
  it('writes one json object per event and flattens newlines', () => {
    const session = createSession({
      id: 'session-1',
      appName: 'demo',
      userId: 'alice',
      events: [
        createEvent({
          author: 'user',
          timestamp: 1,
          content: {parts: [{text: 'first\nline'}, {text: 'second'}]},
        }),
        createEvent({
          author: 'model',
          timestamp: 2,
          content: {parts: [{functionCall: {name: 'no_text'}}]},
        }),
        createEvent({author: 'model', timestamp: 3}),
      ],
    });

    const lines = serializeSessionTranscript(session).split('\n');

    expect(lines).toEqual([
      JSON.stringify({
        author: 'user',
        timestamp: 1,
        text: 'first line.second',
      }),
    ]);
  });

  it('returns an empty string for a session with no text events', () => {
    const session = createSession({id: 'session-1', appName: 'demo'});

    expect(serializeSessionTranscript(session)).toBe('');
  });
});

describe('parseTranscriptEvents', () => {
  it('keeps the neighbours of a line that is not valid json', () => {
    const text = [
      JSON.stringify({author: 'user', timestamp: 1, text: 'first'}),
      '   ',
      '{"author": "user", "timesta',
      JSON.stringify({author: 'model', timestamp: 2, text: 'second'}),
    ].join('\n');

    expect(parseTranscriptEvents(text)).toEqual([
      {author: 'user', timestamp: 1, text: 'first'},
      {author: 'model', timestamp: 2, text: 'second'},
    ]);
  });

  it('defaults the missing fields of a json object', () => {
    expect(parseTranscriptEvents('{}')).toEqual([
      {author: '', timestamp: 0, text: ''},
    ]);
  });

  it('drops a line whose timestamp is not a number', () => {
    const text = JSON.stringify({
      author: 'user',
      timestamp: 'later',
      text: 'x',
    });

    expect(parseTranscriptEvents(text)).toEqual([]);
  });

  it('drops a line that is valid json but not an object', () => {
    expect(parseTranscriptEvents('42\nnull')).toEqual([]);
  });
});

describe('mergeEventLists', () => {
  it('keeps lists that share no timestamp apart', () => {
    const merged = mergeEventLists([[event(1)], [event(2)]]);

    expect(timestampsOf(merged)).toEqual([[1], [2]]);
  });

  it('collapses transitively overlapping lists into one', () => {
    const merged = mergeEventLists([
      [event(1), event(2)],
      [event(3), event(4)],
      [event(2), event(3)],
    ]);

    expect(timestampsOf(merged)).toEqual([[1, 2, 3, 4]]);
  });

  it('does not repeat an event that appears in two lists', () => {
    const merged = mergeEventLists([[event(1), event(2)], [event(2)]]);

    expect(timestampsOf(merged)).toEqual([[1, 2]]);
  });

  it('leaves the input lists untouched', () => {
    const first = [event(1)];
    const second = [event(1), event(2)];

    mergeEventLists([first, second]);

    expect(timestampsOf([first, second])).toEqual([[1], [1, 2]]);
  });

  it('returns nothing for no lists', () => {
    expect(mergeEventLists([])).toEqual([]);
  });
});
