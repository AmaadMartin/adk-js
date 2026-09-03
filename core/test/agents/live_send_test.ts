/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  AsyncQueue,
  BaseLlmConnection,
  Event,
  InMemorySessionService,
  InvocationContext,
  LlmResponse,
  PluginManager,
  SendContentOptions,
  Session,
} from '@google/adk';
import {Blob, Content} from '@google/genai';
import {beforeEach, describe, expect, it} from 'vitest';
import {dispatchLiveRequest} from '../../src/agents/live_send.js';

const APP_NAME = 'live_send_app';
const USER_ID = 'live_send_user';

/** Records everything the send loop pushes at the model. */
class RecordingConnection implements BaseLlmConnection {
  readonly contentCalls: Array<{content: Content; partial?: boolean}> = [];
  readonly realtimeCalls: Blob[] = [];
  activityStartCalls = 0;
  activityEndCalls = 0;
  audioStreamEndCalls = 0;
  closed = false;
  private readonly queue = new AsyncQueue<LlmResponse>();

  async sendHistory(): Promise<void> {}

  async sendContent(
    content: Content,
    options?: SendContentOptions,
  ): Promise<void> {
    this.contentCalls.push({content, partial: options?.partial});
  }

  async sendRealtime(blob: Blob): Promise<void> {
    this.realtimeCalls.push(blob);
  }

  async sendActivityStart(): Promise<void> {
    this.activityStartCalls += 1;
  }

  async sendActivityEnd(): Promise<void> {
    this.activityEndCalls += 1;
  }

  async sendAudioStreamEnd(): Promise<void> {
    this.audioStreamEndCalls += 1;
  }

  async *receive(): AsyncGenerator<LlmResponse, void, void> {
    yield* this.queue;
  }

  async close(): Promise<void> {
    this.closed = true;
    this.queue.close();
  }
}

/** A connection that declares none of the optional realtime signal methods. */
class MinimalConnection implements BaseLlmConnection {
  readonly realtimeCalls: Blob[] = [];
  private readonly queue = new AsyncQueue<LlmResponse>();

  async sendHistory(): Promise<void> {}
  async sendContent(): Promise<void> {}
  async sendRealtime(blob: Blob): Promise<void> {
    this.realtimeCalls.push(blob);
  }
  async *receive(): AsyncGenerator<LlmResponse, void, void> {
    yield* this.queue;
  }
  async close(): Promise<void> {
    this.queue.close();
  }
}

async function createContext(
  options: {withSessionService?: boolean} = {},
): Promise<{context: InvocationContext; session: Session}> {
  const sessionService = new InMemorySessionService();
  const session = await sessionService.createSession({
    appName: APP_NAME,
    userId: USER_ID,
  });
  const context = new InvocationContext({
    invocationId: 'inv_live_send',
    session,
    sessionService:
      options.withSessionService === false ? undefined : sessionService,
    pluginManager: new PluginManager(),
  });
  return {context, session};
}

function userEvents(session: Session): Event[] {
  return session.events.filter((event) => event.author === 'user');
}

describe('dispatchLiveRequest', () => {
  let connection: RecordingConnection;

  beforeEach(() => {
    connection = new RecordingConnection();
  });

  describe('state delta', () => {
    it('appends a standalone user event when the request has no content', async () => {
      const {context, session} = await createContext();

      await dispatchLiveRequest(context, connection, {
        stateDelta: {theme: 'dark'},
      });

      const appended = userEvents(session);
      expect(appended).toHaveLength(1);
      expect(appended[0].content).toBeUndefined();
      expect(appended[0].actions.stateDelta).toEqual({theme: 'dark'});
      expect(session.state['theme']).toBe('dark');
      expect(connection.contentCalls).toHaveLength(0);
    });

    it('rides on the single user content event when the request has content', async () => {
      const {context, session} = await createContext();
      const content: Content = {role: 'user', parts: [{text: 'hello'}]};

      await dispatchLiveRequest(context, connection, {
        content,
        stateDelta: {theme: 'dark'},
      });

      const appended = userEvents(session);
      expect(appended).toHaveLength(1);
      expect(appended[0].content).toEqual(content);
      expect(appended[0].actions.stateDelta).toEqual({theme: 'dark'});
      expect(connection.contentCalls).toEqual([{content}]);
    });

    it('gets its own event when the content is a partial turn update', async () => {
      const {context, session} = await createContext();
      const content: Content = {role: 'user', parts: [{text: 'half a '}]};

      await dispatchLiveRequest(context, connection, {
        content,
        partial: true,
        stateDelta: {theme: 'dark'},
      });

      const appended = userEvents(session);
      expect(appended).toHaveLength(1);
      expect(appended[0].content).toBeUndefined();
      expect(appended[0].actions.stateDelta).toEqual({theme: 'dark'});
      expect(connection.contentCalls).toEqual([{content, partial: true}]);
    });

    it('gets its own event when the content is a function response', async () => {
      const {context, session} = await createContext();
      const content: Content = {
        role: 'user',
        parts: [{functionResponse: {name: 'roll', response: {result: 4}}}],
      };

      await dispatchLiveRequest(context, connection, {
        content,
        stateDelta: {rolled: true},
      });

      const appended = userEvents(session);
      expect(appended).toHaveLength(1);
      expect(appended[0].content).toBeUndefined();
      expect(appended[0].actions.stateDelta).toEqual({rolled: true});
      expect(connection.contentCalls).toHaveLength(1);
    });

    it('is appended before the connection closes', async () => {
      const {context, session} = await createContext();

      await dispatchLiveRequest(context, connection, {
        close: true,
        stateDelta: {theme: 'dark'},
      });

      const appended = userEvents(session);
      expect(appended).toHaveLength(1);
      expect(appended[0].actions.stateDelta).toEqual({theme: 'dark'});
      expect(connection.closed).toBe(true);
    });

    it('is dropped when the invocation has no session service', async () => {
      const {context, session} = await createContext({
        withSessionService: false,
      });

      await dispatchLiveRequest(context, connection, {
        stateDelta: {theme: 'dark'},
      });

      expect(session.events).toHaveLength(0);
      expect(session.state['theme']).toBeUndefined();
    });
  });

  describe('content', () => {
    it('appends an event with an empty delta when the request has none', async () => {
      const {context, session} = await createContext();
      const content: Content = {role: 'user', parts: [{text: 'hello'}]};

      await dispatchLiveRequest(context, connection, {content});

      const appended = userEvents(session);
      expect(appended).toHaveLength(1);
      expect(appended[0].actions.stateDelta).toEqual({});
    });

    it('defaults a missing role to user', async () => {
      const {context, session} = await createContext();
      const content: Content = {parts: [{text: 'hello'}]};

      await dispatchLiveRequest(context, connection, {content});

      expect(content.role).toBe('user');
      expect(userEvents(session)[0].content?.role).toBe('user');
    });

    it('leaves a function response role unset', async () => {
      const {context} = await createContext();
      const content: Content = {
        parts: [{functionResponse: {name: 'roll', response: {result: 4}}}],
      };

      await dispatchLiveRequest(context, connection, {content});

      expect(content.role).toBeUndefined();
    });

    it('rejects a content that carries a function call', async () => {
      const {context} = await createContext();
      const content: Content = {
        role: 'user',
        parts: [{functionCall: {name: 'roll', args: {}}}],
      };

      await expect(
        dispatchLiveRequest(context, connection, {content}),
      ).rejects.toThrow('User message cannot contain function calls.');
    });
  });

  describe('realtime signals', () => {
    it('starts an activity when only that signal is set', async () => {
      const {context} = await createContext();

      await dispatchLiveRequest(context, connection, {activityStart: {}});

      expect(connection.activityStartCalls).toBe(1);
    });

    it('forwards an audio stream end signal', async () => {
      const {context} = await createContext();

      await dispatchLiveRequest(context, connection, {audioStreamEnd: true});

      expect(connection.audioStreamEndCalls).toBe(1);
      expect(connection.realtimeCalls).toHaveLength(0);
    });

    it('prefers an activity signal over an audio stream end signal', async () => {
      const {context} = await createContext();

      await dispatchLiveRequest(context, connection, {
        activityEnd: {},
        audioStreamEnd: true,
      });

      expect(connection.activityEndCalls).toBe(1);
      expect(connection.audioStreamEndCalls).toBe(0);
    });

    it('prefers an audio stream end signal over a blob', async () => {
      const {context} = await createContext();
      const blob: Blob = {mimeType: 'audio/pcm', data: 'AAAA'};

      await dispatchLiveRequest(context, connection, {
        audioStreamEnd: true,
        blob,
      });

      expect(connection.audioStreamEndCalls).toBe(1);
      expect(connection.realtimeCalls).toHaveLength(0);
    });

    it('sends a blob and its accompanying content', async () => {
      const {context} = await createContext();
      const blob: Blob = {mimeType: 'audio/pcm', data: 'AAAA'};
      const content: Content = {role: 'user', parts: [{text: 'and this'}]};

      await dispatchLiveRequest(context, connection, {blob, content});

      expect(connection.realtimeCalls).toEqual([blob]);
      expect(connection.contentCalls).toHaveLength(1);
    });

    it('skips a signal a connection does not implement', async () => {
      const minimal = new MinimalConnection();
      const {context} = await createContext();

      await dispatchLiveRequest(context, minimal, {activityStart: {}});
      await dispatchLiveRequest(context, minimal, {activityEnd: {}});
      await dispatchLiveRequest(context, minimal, {audioStreamEnd: true});

      expect(minimal.realtimeCalls).toHaveLength(0);
    });
  });
});
