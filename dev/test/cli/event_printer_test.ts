/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {createEvent} from '@google/adk';
import {afterEach, beforeEach, describe, expect, it, Mock, vi} from 'vitest';
import {
  printEvent,
  renderUserInputRequest,
} from '../../src/cli/event_printer.js';

/** What `console.log` received, one entry per call. */
function loggedLines(): string[] {
  return (console.log as Mock).mock.calls.map((call) => call.join(' '));
}

/** What stdout received, which is where a JSONL record goes. */
function stdoutChunks(): string[] {
  return (process.stdout.write as Mock).mock.calls.map((call) =>
    String(call[0]),
  );
}

/** The single JSON record a JSONL run wrote to stdout. */
function loggedRecord(): Record<string, unknown> {
  const chunks = stdoutChunks();
  expect(chunks).toHaveLength(1);
  return JSON.parse(chunks[0]) as Record<string, unknown>;
}

describe('printEvent', () => {
  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('human mode', () => {
    it('prints the text of an event under its author', () => {
      printEvent(
        createEvent({
          author: 'model',
          content: {parts: [{text: 'Sunny in Paris.'}]},
        }),
      );

      expect(loggedLines()).toEqual(['[model]: Sunny in Paris.']);
    });

    it('prints a node output when the event carries no text', () => {
      printEvent(createEvent({author: 'summarize', output: {count: 2}}));

      expect(loggedLines()).toEqual(['[summarize]: {"count":2}']);
    });

    it('names an empty string output rather than printing nothing', () => {
      printEvent(createEvent({author: 'summarize', output: ''}));

      expect(loggedLines()).toEqual(['[summarize]: (empty response)']);
    });

    it('attributes an event that names no author', () => {
      printEvent(createEvent({content: {parts: [{text: 'hi'}]}}));

      expect(loggedLines()).toEqual(['[agent]: hi']);
    });

    it('falls back to String() for an output JSON cannot render', () => {
      const circular: Record<string, unknown> = {};
      circular['self'] = circular;

      printEvent(createEvent({author: 'summarize', output: circular}));

      expect(loggedLines()).toEqual(['[summarize]: [object Object]']);
    });

    it('falls back to String() for an output JSON drops', () => {
      printEvent(createEvent({author: 'summarize', output: () => 'hi'}));

      expect(loggedLines()[0]).toContain('[summarize]: () =>');
    });

    it('reports an error carried on the event', () => {
      printEvent(
        createEvent({
          author: 'draft',
          errorCode: 'SAFETY',
          errorMessage: 'blocked',
        }),
      );

      expect(console.error).toHaveBeenCalledWith(
        '[draft] error: SAFETY: blocked',
      );
    });

    it('announces a pause the event raised', () => {
      printEvent(
        createEvent({
          author: 'step1',
          content: {
            parts: [
              {
                functionCall: {
                  name: 'adk_request_input',
                  id: 'interrupt-1',
                  args: {message: 'Enter a number:'},
                },
              },
            ],
          },
        }),
      );

      expect(loggedLines().join('\n')).toContain(
        '--- [step1] is waiting for your input ---\nEnter a number:',
      );
    });

    it('stays quiet about a pause when announcements are off', () => {
      printEvent(
        createEvent({
          author: 'step1',
          content: {
            parts: [
              {
                functionCall: {
                  name: 'adk_request_input',
                  id: 'interrupt-1',
                  args: {message: 'Enter a number:'},
                },
              },
            ],
          },
        }),
        {announcePauses: false},
      );

      expect(loggedLines()).toEqual([]);
    });
  });

  describe('jsonl mode', () => {
    it('writes exactly one JSON line and no readable text', () => {
      printEvent(
        createEvent({
          author: 'model',
          id: 'e1',
          content: {parts: [{text: 'Sunny in Paris.'}]},
        }),
        {jsonl: true},
      );

      const record = loggedRecord();
      expect(record['author']).toBe('model');
      expect(loggedLines()).toEqual([]);
    });

    it('leads with author, session_id, node_path and id', () => {
      printEvent(
        createEvent({
          author: 'model',
          id: 'e1',
          nodeInfo: {path: 'wf.child.0'},
          content: {parts: [{text: 'hi'}]},
        }),
        {jsonl: true, sessionId: 'session-123'},
      );

      const record = loggedRecord();
      expect(Object.keys(record).slice(0, 4)).toEqual([
        'author',
        'session_id',
        'node_path',
        'id',
      ]);
      expect(record['session_id']).toBe('session-123');
      expect(record['node_path']).toBe('wf.child.0');
    });

    it('omits session_id and node_path when neither is known', () => {
      printEvent(createEvent({author: 'model', id: 'e1'}), {jsonl: true});

      const record = loggedRecord();
      expect(record).not.toHaveProperty('session_id');
      expect(record).not.toHaveProperty('node_path');
      expect(Object.keys(record).slice(0, 2)).toEqual(['author', 'id']);
    });

    it('keeps non-ASCII text unescaped', () => {
      printEvent(
        createEvent({
          author: 'model',
          content: {parts: [{text: '日本語の回答'}]},
        }),
        {jsonl: true},
      );

      const line = stdoutChunks()[0];
      expect(line).toContain('日本語の回答');
      expect(line).not.toContain('\\u');
    });

    it('drops the action maps an ordinary event leaves empty', () => {
      printEvent(createEvent({author: 'model'}), {jsonl: true});

      expect(loggedRecord()).not.toHaveProperty('actions');
    });

    it('keeps the actions that carry something', () => {
      printEvent(
        createEvent({author: 'model', actions: {stateDelta: {tier: 'gold'}}}),
        {jsonl: true},
      );

      expect(loggedRecord()['actions']).toEqual({stateDelta: {tier: 'gold'}});
    });

    it('keeps a scalar action alongside the dropped empty maps', () => {
      printEvent(createEvent({author: 'model', actions: {escalate: true}}), {
        jsonl: true,
      });

      expect(loggedRecord()['actions']).toEqual({escalate: true});
    });

    it('leaves the event untouched so a later reader still sees its actions', () => {
      const event = createEvent({author: 'model'});

      printEvent(event, {jsonl: true});

      expect(event.actions.stateDelta).toEqual({});
    });

    it('prints an event that carries no actions at all', () => {
      const event = createEvent({author: 'model', id: 'e1'});
      // A caller can hand the printer an event it built itself, without the
      // actions `createEvent` would have added.
      Reflect.deleteProperty(event, 'actions');

      printEvent(event, {jsonl: true});

      const record = loggedRecord();
      expect(record).not.toHaveProperty('actions');
      expect(record['author']).toBe('model');
    });

    it('says nothing about a pause the event raised', () => {
      printEvent(
        createEvent({
          author: 'step1',
          content: {
            parts: [
              {
                functionCall: {
                  name: 'adk_request_input',
                  id: 'interrupt-1',
                  args: {message: 'Enter a number:'},
                },
              },
            ],
          },
        }),
        {jsonl: true},
      );

      expect(loggedLines()).toEqual([]);
      expect(stdoutChunks()[0]).not.toContain('is waiting for your input');
      expect(loggedRecord()['longRunningToolIds']).toEqual([]);
    });
  });
});

describe('renderUserInputRequest', () => {
  it('describes a credential request and its auth scheme', () => {
    const rendered = renderUserInputRequest({
      kind: 'credential',
      interruptId: 'weather_api_key',
      functionCallName: 'adk_request_credential',
      author: 'fetch_weather',
      message: 'Please provide your API key.',
      authConfig: {
        credentialKey: 'weather_api_key',
        authScheme: {type: 'apiKey', in: 'header', name: 'X-Api-Key'},
      },
    });

    expect(rendered).toBe(
      '--- [fetch_weather] is waiting for a credential ---\n' +
        'Please provide your API key.\n' +
        'Auth scheme: apiKey (header X-Api-Key)\n' +
        'Type the credential at the next prompt to continue.',
    );
  });

  it('describes a confirmation request and how to answer it', () => {
    const rendered = renderUserInputRequest({
      kind: 'confirmation',
      interruptId: 'confirm-1',
      functionCallName: 'adk_request_confirmation',
      author: 'generate_instruction',
      message: 'This reads patient records.',
      toolName: 'find_orders',
    });

    expect(rendered).toBe(
      '--- [generate_instruction] is waiting for confirmation ---\n' +
        'Tool: find_orders\n' +
        'This reads patient records.\n' +
        "Reply 'yes' to approve or 'no' to reject.",
    );
  });

  it('falls back to a generic author when the request names none', () => {
    const rendered = renderUserInputRequest({
      kind: 'input',
      interruptId: 'interrupt-1',
      functionCallName: 'adk_request_input',
      payload: {draft: 'hi'},
      responseSchema: {type: 'object'},
    });

    expect(rendered).toBe(
      '--- [agent] is waiting for your input ---\n' +
        'Payload: {"draft":"hi"}\n' +
        'Expected response: {"type":"object"}\n' +
        'Type your reply at the next prompt to continue.',
    );
  });
});
