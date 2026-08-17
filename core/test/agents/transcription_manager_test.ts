/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

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
import {describe, expect, it, vi} from 'vitest';

const AGENT_NAME = 'transcribing-agent';
const INVOCATION_ID = 'inv-transcription-1';

function makeSession(events: Event[] = []): Session {
  return createSession({
    id: 'test-session',
    appName: 'test-app',
    userId: 'test-user',
    events,
  });
}

function makeContext(events: Event[] = []): InvocationContext {
  return new InvocationContext({
    invocationId: INVOCATION_ID,
    agent: new LlmAgent({name: AGENT_NAME}),
    session: makeSession(events),
    pluginManager: new PluginManager(),
  });
}

/** A context for a bare node run, which has no agent. */
function makeAgentlessContext(): InvocationContext {
  return new InvocationContext({
    invocationId: INVOCATION_ID,
    session: makeSession(),
    pluginManager: new PluginManager(),
  });
}

describe('TranscriptionManager.handleInputTranscription', () => {
  it('authors the event as the user and carries the transcription by reference', () => {
    const manager = new TranscriptionManager();
    const context = makeContext();
    const transcription = {text: 'what is the weather in Zurich'};

    const event = manager.handleInputTranscription(context, transcription);

    expect(event.author).toBe('user');
    expect(event.invocationId).toBe(INVOCATION_ID);
    expect(event.inputTranscription).toBe(transcription);
    expect(event.outputTranscription).toBeUndefined();
  });

  it('leaves the transcription fields unmodified', () => {
    const manager = new TranscriptionManager();
    const transcription = {text: 'test transcription content', finished: true};

    const event = manager.handleInputTranscription(
      makeContext(),
      transcription,
    );

    expect(event.inputTranscription).toEqual({
      text: 'test transcription content',
      finished: true,
    });
  });

  it('accepts a transcription that carries no text', () => {
    const manager = new TranscriptionManager();
    const transcription = {};

    const event = manager.handleInputTranscription(
      makeContext(),
      transcription,
    );

    expect(event.inputTranscription).toBe(transcription);
  });

  it('does not mark the event partial', () => {
    const manager = new TranscriptionManager();

    const event = manager.handleInputTranscription(makeContext(), {text: 'hi'});

    expect(event.partial).toBeUndefined();
  });

  it('succeeds when the invocation has no agent', () => {
    const manager = new TranscriptionManager();

    const event = manager.handleInputTranscription(makeAgentlessContext(), {
      text: 'hello from a node',
    });

    expect(event.author).toBe('user');
  });
});

describe('TranscriptionManager.handleOutputTranscription', () => {
  it('authors the event as the agent and carries the transcription by reference', () => {
    const manager = new TranscriptionManager();
    const context = makeContext();
    const transcription = {text: 'it is 18 degrees and clear'};

    const event = manager.handleOutputTranscription(context, transcription);

    expect(event.author).toBe(AGENT_NAME);
    expect(event.invocationId).toBe(INVOCATION_ID);
    expect(event.outputTranscription).toBe(transcription);
    expect(event.inputTranscription).toBeUndefined();
  });

  it('does not mark the event partial', () => {
    const manager = new TranscriptionManager();

    const event = manager.handleOutputTranscription(makeContext(), {
      text: 'hi',
    });

    expect(event.partial).toBeUndefined();
  });

  it('throws when the invocation has no agent', () => {
    const manager = new TranscriptionManager();

    expect(() =>
      manager.handleOutputTranscription(makeAgentlessContext(), {text: 'hi'}),
    ).toThrow(/InvocationContext.agent is not set/);
  });
});

describe('TranscriptionManager session side effects', () => {
  it('never writes the event to the session', async () => {
    const manager = new TranscriptionManager();
    const sessionService = new InMemorySessionService();
    const session = await sessionService.createSession({
      appName: 'test-app',
      userId: 'test-user',
    });
    const appendEvent = vi.spyOn(sessionService, 'appendEvent');
    const context = new InvocationContext({
      invocationId: INVOCATION_ID,
      agent: new LlmAgent({name: AGENT_NAME}),
      session,
      sessionService,
      pluginManager: new PluginManager(),
    });

    manager.handleInputTranscription(context, {text: 'from the user'});
    manager.handleOutputTranscription(context, {text: 'from the model'});

    expect(appendEvent).not.toHaveBeenCalled();
    expect(session.events).toEqual([]);
    const stored = await sessionService.getSession({
      appName: 'test-app',
      userId: 'test-user',
      sessionId: session.id,
    });
    expect(stored?.events).toEqual([]);
  });

  it('keeps repeated calls independent', () => {
    const manager = new TranscriptionManager();
    const context = makeContext();

    const events = [
      manager.handleInputTranscription(context, {text: 'user 0'}),
      manager.handleInputTranscription(context, {text: 'user 1'}),
      manager.handleInputTranscription(context, {text: 'user 2'}),
      manager.handleOutputTranscription(context, {text: 'model 0'}),
      manager.handleOutputTranscription(context, {text: 'model 1'}),
    ];

    expect(events.map((event) => event.author)).toEqual([
      'user',
      'user',
      'user',
      AGENT_NAME,
      AGENT_NAME,
    ]);
    expect(new Set(events.map((event) => event.id)).size).toBe(5);
    expect(context.session.events).toEqual([]);
  });
});

describe('TranscriptionManager.getTranscriptionStats', () => {
  it('counts nothing in an empty session', () => {
    const manager = new TranscriptionManager();

    expect(manager.getTranscriptionStats(makeContext())).toEqual({
      inputTranscriptions: 0,
      outputTranscriptions: 0,
      totalTranscriptions: 0,
    });
  });

  it('counts input and output transcriptions across a mixed session', () => {
    const manager = new TranscriptionManager();
    const context = makeContext([
      createEvent({inputTranscription: {text: 'user 1'}}),
      createEvent({outputTranscription: {text: 'model response'}}),
      createEvent({inputTranscription: {text: 'user 2'}}),
      createEvent({content: {role: 'user', parts: [{text: 'typed'}]}}),
    ]);

    expect(manager.getTranscriptionStats(context)).toEqual({
      inputTranscriptions: 2,
      outputTranscriptions: 1,
      totalTranscriptions: 3,
    });
  });

  it('counts nothing when no event carries a transcription', () => {
    const manager = new TranscriptionManager();
    const context = makeContext([createEvent({}), createEvent({})]);

    expect(manager.getTranscriptionStats(context)).toEqual({
      inputTranscriptions: 0,
      outputTranscriptions: 0,
      totalTranscriptions: 0,
    });
  });

  it('counts a transcription that carries no text', () => {
    const manager = new TranscriptionManager();
    const context = makeContext([
      createEvent({inputTranscription: {text: ''}}),
      createEvent({outputTranscription: {}}),
    ]);

    expect(manager.getTranscriptionStats(context)).toEqual({
      inputTranscriptions: 1,
      outputTranscriptions: 1,
      totalTranscriptions: 2,
    });
  });

  it('counts an event carrying both transcriptions once in each bucket', () => {
    const manager = new TranscriptionManager();
    const context = makeContext([
      createEvent({
        inputTranscription: {text: 'user'},
        outputTranscription: {text: 'model'},
      }),
    ]);

    expect(manager.getTranscriptionStats(context)).toEqual({
      inputTranscriptions: 1,
      outputTranscriptions: 1,
      totalTranscriptions: 2,
    });
  });

  it('leaves the session unchanged when called twice', () => {
    const manager = new TranscriptionManager();
    const context = makeContext([
      createEvent({inputTranscription: {text: 'user'}}),
    ]);

    const first = manager.getTranscriptionStats(context);
    const second = manager.getTranscriptionStats(context);

    expect(second).toEqual(first);
    expect(context.session.events).toHaveLength(1);
  });
});
