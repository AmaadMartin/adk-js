/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  ActiveStreamingTool,
  AudioCacheManager,
  Event,
  InMemorySessionService,
  InvocationContext,
  LiveRequest,
  LiveRequestQueue,
  LlmAgent,
  PluginManager,
  Session,
  applyVoiceActivity,
  createEvent,
  fanOutLiveRequest,
  handleControlEventFlush,
  persistLiveRequest,
} from '@google/adk';
import {Content, VoiceActivityType} from '@google/genai';
import {describe, expect, it, vi} from 'vitest';

const APP_NAME = 'test-app';
const USER_ID = 'test-user';
const SESSION_ID = 'test-session';

async function createContext(): Promise<{
  context: InvocationContext;
  sessionService: InMemorySessionService;
  session: Session;
}> {
  const sessionService = new InMemorySessionService();
  const session = await sessionService.createSession({
    appName: APP_NAME,
    userId: USER_ID,
    sessionId: SESSION_ID,
  });
  const context = new InvocationContext({
    invocationId: 'test-invocation',
    agent: new LlmAgent({name: 'test_agent'}),
    session,
    sessionService,
    pluginManager: new PluginManager(),
  });
  return {context, sessionService, session};
}

describe('fanOutLiveRequest', () => {
  it('forwards the exact request to every active streaming tool', async () => {
    const {context} = await createContext();
    const queueA = new LiveRequestQueue();
    const queueB = new LiveRequestQueue();
    const sendA = vi.spyOn(queueA, 'send');
    const sendB = vi.spyOn(queueB, 'send');
    context.activeStreamingTools = {
      a: new ActiveStreamingTool({stream: queueA}),
      b: new ActiveStreamingTool({stream: queueB}),
    };

    const liveRequest: LiveRequest = {
      content: {role: 'user', parts: [{text: 'hi'}]},
    };
    fanOutLiveRequest(context, liveRequest);

    expect(sendA).toHaveBeenCalledWith(liveRequest);
    expect(sendB).toHaveBeenCalledWith(liveRequest);
  });

  it('is a no-op when there are no active streaming tools', async () => {
    const {context} = await createContext();
    expect(() => fanOutLiveRequest(context, {close: true})).not.toThrow();
  });

  it('skips a tool without a stream', async () => {
    const {context} = await createContext();
    const queue = new LiveRequestQueue();
    const send = vi.spyOn(queue, 'send');
    context.activeStreamingTools = {
      withStream: new ActiveStreamingTool({stream: queue}),
      withoutStream: new ActiveStreamingTool(),
    };

    fanOutLiveRequest(context, {blob: {data: 'AAAA', mimeType: 'audio/pcm'}});

    expect(send).toHaveBeenCalledOnce();
  });
});

describe('persistLiveRequest', () => {
  it('applies a state delta via a content-less user event', async () => {
    const {context, session} = await createContext();

    await persistLiveRequest(context, {stateDelta: {k: 'v'}});

    expect(session.state['k']).toBe('v');
    expect(session.events).toHaveLength(1);
    expect(session.events[0].content).toBeUndefined();
    expect(session.events[0].author).toBe('user');
  });

  it('rides the state delta on a single user content event', async () => {
    const {context, session} = await createContext();
    const content: Content = {role: 'user', parts: [{text: 'hi'}]};

    await persistLiveRequest(context, {content, stateDelta: {k: 'v'}});

    expect(session.state['k']).toBe('v');
    expect(session.events).toHaveLength(1);
    expect(session.events[0].content).toEqual(content);
    expect(session.events[0].actions.stateDelta).toEqual({k: 'v'});
  });

  it('persists user content without a state delta', async () => {
    const {context, session} = await createContext();
    const content: Content = {role: 'user', parts: [{text: 'hello'}]};

    await persistLiveRequest(context, {content});

    expect(session.events).toHaveLength(1);
    expect(session.events[0].content).toEqual(content);
    expect(session.events[0].actions.stateDelta).toEqual({});
  });

  it('does not create a content event for a partial turn but applies the delta', async () => {
    const {context, session} = await createContext();
    const content: Content = {role: 'user', parts: [{text: 'progress'}]};

    await persistLiveRequest(context, {
      content,
      stateDelta: {k: 'v'},
      partial: true,
    });

    expect(session.state['k']).toBe('v');
    expect(session.events.every((e) => e.content === undefined)).toBe(true);
  });

  it('does not create a content event for a function response but applies the delta', async () => {
    const {context, session} = await createContext();
    const content: Content = {
      role: 'user',
      parts: [{functionResponse: {name: 'tool', response: {result: 'ok'}}}],
    };

    await persistLiveRequest(context, {content, stateDelta: {k: 'v'}});

    expect(session.state['k']).toBe('v');
    expect(session.events.every((e) => e.content === undefined)).toBe(true);
  });

  it('applies the delta even when the request also closes the connection', async () => {
    const {context, session} = await createContext();

    await persistLiveRequest(context, {stateDelta: {k: 'v'}, close: true});

    expect(session.state['k']).toBe('v');
  });

  it('defaults a missing content role to user', async () => {
    const {context, session} = await createContext();
    const content: Content = {parts: [{text: 'no role'}]};

    await persistLiveRequest(context, {content});

    expect(session.events).toHaveLength(1);
    expect(session.events[0].content?.role).toBe('user');
  });

  it('throws when the content contains a function call', async () => {
    const {context} = await createContext();
    const content: Content = {
      role: 'user',
      parts: [{functionCall: {name: 'some_tool', args: {key: 'value'}}}],
    };

    await expect(persistLiveRequest(context, {content})).rejects.toThrowError(
      'User message cannot contain function calls.',
    );
  });
});

describe('handleControlEventFlush', () => {
  it('flushes model audio only on an interrupted response', async () => {
    const {context} = await createContext();
    const manager = new AudioCacheManager();
    const event = createEvent({author: 'test_agent'});
    const flushSpy = vi
      .spyOn(manager, 'flushCaches')
      .mockResolvedValue([event]);

    const result = await handleControlEventFlush(
      context,
      {interrupted: true},
      manager,
    );

    expect(flushSpy).toHaveBeenCalledWith(context, {
      flushUserAudio: false,
      flushModelAudio: true,
    });
    expect(result).toEqual([event]);
  });

  it('flushes both caches on a turn-complete response', async () => {
    const {context} = await createContext();
    const manager = new AudioCacheManager();
    const flushSpy = vi.spyOn(manager, 'flushCaches').mockResolvedValue([]);

    await handleControlEventFlush(context, {turnComplete: true}, manager);

    expect(flushSpy).toHaveBeenCalledWith(context, {
      flushUserAudio: true,
      flushModelAudio: true,
    });
  });

  it('returns an empty list for a non-control response', async () => {
    const {context} = await createContext();
    const manager = new AudioCacheManager();
    const flushSpy = vi.spyOn(manager, 'flushCaches');

    const result = await handleControlEventFlush(
      context,
      {content: {role: 'model', parts: [{text: 'hi'}]}},
      manager,
    );

    expect(result).toEqual([]);
    expect(flushSpy).not.toHaveBeenCalled();
  });
});

describe('applyVoiceActivity', () => {
  it('copies the voice activity signal onto the event', () => {
    const event: Event = createEvent({author: 'test_agent'});
    const voiceActivity = {
      voiceActivityType: VoiceActivityType.ACTIVITY_START,
      audioOffset: '1.5s',
    };

    const result = applyVoiceActivity({voiceActivity}, event);

    expect(result).toBe(event);
    expect(result?.voiceActivity).toEqual(voiceActivity);
  });

  it('returns undefined when the response carries no voice activity', () => {
    const event: Event = createEvent({author: 'test_agent'});

    expect(applyVoiceActivity({}, event)).toBeUndefined();
    expect(event.voiceActivity).toBeUndefined();
  });
});
