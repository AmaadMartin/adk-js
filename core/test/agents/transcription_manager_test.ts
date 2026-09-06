/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

// Ported from google/adk-python tests/unittests/live/test_transcription_manager.py
// (branch: main). Test names are kept verbatim from the Python originals.

import {
  Event,
  InMemorySessionService,
  InvocationContext,
  LlmAgent,
  PluginManager,
  Session,
  TranscriptionManager,
  createEvent,
  createSession,
} from '@google/adk';
import {Transcription} from '@google/genai';
import {beforeEach, describe, expect, it, vi} from 'vitest';

function makeSession(events: Event[] = []): Session {
  return createSession({
    id: 'test-session',
    appName: 'test-app',
    userId: 'test-user',
    events,
  });
}

function makeContext(
  options: {
    agentName?: string | null;
    sessionService?: InMemorySessionService;
    events?: Event[];
  } = {},
): InvocationContext {
  const {agentName = 'test_agent', sessionService, events} = options;
  return new InvocationContext({
    invocationId: 'test-invocation-id',
    agent: agentName === null ? undefined : new LlmAgent({name: agentName}),
    session: makeSession(events),
    sessionService,
    pluginManager: new PluginManager(),
  });
}

describe('TranscriptionManager', () => {
  let manager: TranscriptionManager;

  beforeEach(() => {
    manager = new TranscriptionManager();
  });

  it('test_handle_input_transcription', () => {
    const sessionService = new InMemorySessionService();
    const appendEvent = vi.spyOn(sessionService, 'appendEvent');
    const invocationContext = makeContext({sessionService});

    const transcription: Transcription = {text: 'Hello from user'};

    manager.handleInputTranscription(invocationContext, transcription);

    expect(appendEvent).not.toHaveBeenCalled();
  });

  it('test_handle_output_transcription', () => {
    const sessionService = new InMemorySessionService();
    const appendEvent = vi.spyOn(sessionService, 'appendEvent');
    const invocationContext = makeContext({sessionService});

    const transcription: Transcription = {text: 'Hello from model'};

    manager.handleOutputTranscription(invocationContext, transcription);

    expect(appendEvent).not.toHaveBeenCalled();
  });

  it('test_handle_multiple_transcriptions', () => {
    const sessionService = new InMemorySessionService();
    const appendEvent = vi.spyOn(sessionService, 'appendEvent');
    const invocationContext = makeContext({sessionService});

    for (let i = 0; i < 3; i++) {
      manager.handleInputTranscription(invocationContext, {
        text: `User message ${i}`,
      });
    }
    for (let i = 0; i < 2; i++) {
      manager.handleOutputTranscription(invocationContext, {
        text: `Model response ${i}`,
      });
    }

    expect(appendEvent).not.toHaveBeenCalled();
  });

  it('test_transcription_event_content_input', () => {
    const invocationContext = makeContext();
    const transcription: Transcription = {text: 'Test user input'};

    const event = manager.handleInputTranscription(
      invocationContext,
      transcription,
    );

    expect(event.author).toBe('user');
    expect(event.inputTranscription).toEqual(transcription);
    expect(event.outputTranscription).toBeUndefined();
    expect(event.invocationId).toBe(invocationContext.invocationId);
    expect(Number.isFinite(event.timestamp)).toBe(true);
  });

  it('test_transcription_event_content_output', () => {
    const invocationContext = makeContext({agentName: 'my_test_agent'});
    const transcription: Transcription = {text: 'Test model output'};

    const event = manager.handleOutputTranscription(
      invocationContext,
      transcription,
    );

    expect(event.author).toBe('my_test_agent');
    expect(event.outputTranscription).toEqual(transcription);
    expect(event.inputTranscription).toBeUndefined();
    expect(event.invocationId).toBe(invocationContext.invocationId);
    expect(Number.isFinite(event.timestamp)).toBe(true);
  });

  it('test_get_transcription_stats_empty_session', () => {
    const stats = manager.getTranscriptionStats(makeContext());

    expect(stats).toEqual({
      inputTranscriptions: 0,
      outputTranscriptions: 0,
      totalTranscriptions: 0,
    });
  });

  it('test_get_transcription_stats_with_events', () => {
    const events = [
      createEvent({author: 'user', inputTranscription: {text: 'Input 1'}}),
      createEvent({author: 'user', inputTranscription: {text: 'Input 2'}}),
      createEvent({
        author: 'test_agent',
        outputTranscription: {text: 'Output 1'},
      }),
      createEvent({author: 'test_agent'}),
    ];

    const stats = manager.getTranscriptionStats(makeContext({events}));

    expect(stats).toEqual({
      inputTranscriptions: 2,
      outputTranscriptions: 1,
      totalTranscriptions: 3,
    });
  });

  it('test_get_transcription_stats_missing_attributes', () => {
    const events = [
      createEvent({author: 'user'}),
      createEvent({author: 'test_agent'}),
    ];

    const stats = manager.getTranscriptionStats(makeContext({events}));

    expect(stats).toEqual({
      inputTranscriptions: 0,
      outputTranscriptions: 0,
      totalTranscriptions: 0,
    });
  });
});

describe('additional coverage', () => {
  const manager = new TranscriptionManager();

  it('throws when the output path has no agent', () => {
    const invocationContext = makeContext({agentName: null});

    expect(() =>
      manager.handleOutputTranscription(invocationContext, {text: 'no agent'}),
    ).toThrowError(/InvocationContext.agent is not set/);
  });

  it('accepts a transcription that carries no text', () => {
    const invocationContext = makeContext();
    const transcription: Transcription = {finished: true};

    const event = manager.handleInputTranscription(
      invocationContext,
      transcription,
    );

    expect(event.author).toBe('user');
    expect(event.inputTranscription).toBe(transcription);
    expect(event.outputTranscription).toBeUndefined();
  });

  it('counts an event carrying both transcriptions on both sides', () => {
    const events = [
      createEvent({
        author: 'user',
        inputTranscription: {text: 'said'},
        outputTranscription: {text: 'replied'},
      }),
    ];

    const stats = manager.getTranscriptionStats(makeContext({events}));

    expect(stats).toEqual({
      inputTranscriptions: 1,
      outputTranscriptions: 1,
      totalTranscriptions: 2,
    });
  });

  it('gives each event a fresh id', () => {
    const invocationContext = makeContext();

    const first = manager.handleInputTranscription(invocationContext, {
      text: 'one',
    });
    const second = manager.handleInputTranscription(invocationContext, {
      text: 'two',
    });

    expect(first.id).not.toBe(second.id);
    expect(first.id.length).toBeGreaterThan(0);
  });

  it('passes the transcription through without copying it', () => {
    const invocationContext = makeContext();
    const transcription: Transcription = {text: 'same object'};

    const input = manager.handleInputTranscription(
      invocationContext,
      transcription,
    );
    const output = manager.handleOutputTranscription(
      invocationContext,
      transcription,
    );

    expect(input.inputTranscription).toBe(transcription);
    expect(output.outputTranscription).toBe(transcription);
  });

  it('leaves the session events untouched', () => {
    const events = [
      createEvent({author: 'user', inputTranscription: {text: 'kept'}}),
    ];
    const invocationContext = makeContext({events});
    const before = [...invocationContext.session.events];

    manager.handleInputTranscription(invocationContext, {text: 'not appended'});
    manager.handleOutputTranscription(invocationContext, {
      text: 'not appended',
    });
    manager.getTranscriptionStats(invocationContext);

    expect(invocationContext.session.events).toEqual(before);
  });
});
