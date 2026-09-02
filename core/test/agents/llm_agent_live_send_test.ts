/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  AsyncQueue,
  BaseLlm,
  BaseLlmConnection,
  Event,
  InMemorySessionService,
  InvocationContext,
  LiveRequest,
  LiveRequestQueue,
  LlmAgent,
  LlmRequest,
  LlmResponse,
  PluginManager,
  Session,
} from '@google/adk';
import {Blob, Content} from '@google/genai';
import {beforeEach, describe, expect, it} from 'vitest';

const APP_NAME = 'live_send_app';
const USER_ID = 'live_send_user';

/** Records everything the send loop pushes at the model. */
class RecordingConnection implements BaseLlmConnection {
  readonly contentCalls: Array<{
    content: Content;
    options?: {partial?: boolean};
  }> = [];
  readonly realtimeCalls: Blob[] = [];
  activityStartCalls = 0;
  activityEndCalls = 0;
  audioStreamEndCalls = 0;
  closed = false;
  private readonly queue = new AsyncQueue<LlmResponse>();

  async sendHistory(): Promise<void> {}

  async sendContent(
    content: Content,
    options?: {partial?: boolean},
  ): Promise<void> {
    this.contentCalls.push({content, options});
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

class FakeLiveLlm extends BaseLlm {
  constructor(readonly liveConnection: BaseLlmConnection) {
    super({model: 'fake-live-llm'});
  }

  // eslint-disable-next-line require-yield -- BaseLlm mandates an AsyncGenerator; these tests never call the non-live path.
  override async *generateContentAsync(): AsyncGenerator<
    LlmResponse,
    void,
    void
  > {
    throw new Error('generateContentAsync is not used in live tests');
  }

  override async connect(_llmRequest: LlmRequest): Promise<BaseLlmConnection> {
    return this.liveConnection;
  }
}

interface Harness {
  agent: LlmAgent;
  session: Session;
  sessionService: InMemorySessionService;
  queue: LiveRequestQueue;
  invocationContext: InvocationContext;
}

async function createHarness(
  connection: BaseLlmConnection,
  options: {withSessionService?: boolean} = {},
): Promise<Harness> {
  const sessionService = new InMemorySessionService();
  const session = await sessionService.createSession({
    appName: APP_NAME,
    userId: USER_ID,
  });
  const agent = new LlmAgent({
    name: 'live_send_agent',
    model: new FakeLiveLlm(connection),
  });
  const queue = new LiveRequestQueue();
  const invocationContext = new InvocationContext({
    invocationId: 'inv_live_send',
    agent,
    session,
    sessionService:
      options.withSessionService === false ? undefined : sessionService,
    liveRequestQueue: queue,
    pluginManager: new PluginManager(),
  });
  return {agent, session, sessionService, queue, invocationContext};
}

/**
 * Drains the live run to completion. The requests are queued up front so the
 * send loop consumes them in order and the final `close` ends the run.
 */
async function runLive(
  harness: Harness,
  requests: LiveRequest[],
): Promise<Event[]> {
  for (const request of requests) {
    harness.queue.send(request);
  }
  harness.queue.send({close: true});
  const events: Event[] = [];
  for await (const event of harness.agent.runLive(harness.invocationContext)) {
    events.push(event);
  }
  return events;
}

function userEvents(session: Session): Event[] {
  return session.events.filter((event) => event.author === 'user');
}

describe('LlmAgent live send loop', () => {
  let connection: RecordingConnection;

  beforeEach(() => {
    connection = new RecordingConnection();
  });

  describe('state delta', () => {
    it('appends a standalone user event when the request has no content', async () => {
      const harness = await createHarness(connection);

      await runLive(harness, [{stateDelta: {theme: 'dark'}}]);

      const appended = userEvents(harness.session);
      expect(appended).toHaveLength(1);
      expect(appended[0].content).toBeUndefined();
      expect(appended[0].actions.stateDelta).toEqual({theme: 'dark'});
      expect(harness.session.state['theme']).toBe('dark');
      expect(connection.contentCalls).toHaveLength(0);
    });

    it('rides on the single user content event when the request has content', async () => {
      const harness = await createHarness(connection);
      const content: Content = {role: 'user', parts: [{text: 'hello'}]};

      await runLive(harness, [{content, stateDelta: {theme: 'dark'}}]);

      const appended = userEvents(harness.session);
      expect(appended).toHaveLength(1);
      expect(appended[0].content).toEqual(content);
      expect(appended[0].actions.stateDelta).toEqual({theme: 'dark'});
      expect(connection.contentCalls).toEqual([
        {content, options: {partial: undefined}},
      ]);
    });

    it('gets its own event when the content is a partial turn update', async () => {
      const harness = await createHarness(connection);
      const content: Content = {role: 'user', parts: [{text: 'half a '}]};

      await runLive(harness, [
        {content, partial: true, stateDelta: {theme: 'dark'}},
      ]);

      const appended = userEvents(harness.session);
      expect(appended).toHaveLength(1);
      expect(appended[0].content).toBeUndefined();
      expect(appended[0].actions.stateDelta).toEqual({theme: 'dark'});
      expect(connection.contentCalls).toEqual([
        {content, options: {partial: true}},
      ]);
    });

    it('gets its own event when the content is a function response', async () => {
      const harness = await createHarness(connection);
      const content: Content = {
        role: 'user',
        parts: [{functionResponse: {name: 'roll', response: {result: 4}}}],
      };

      await runLive(harness, [{content, stateDelta: {rolled: true}}]);

      const appended = userEvents(harness.session);
      expect(appended).toHaveLength(1);
      expect(appended[0].content).toBeUndefined();
      expect(appended[0].actions.stateDelta).toEqual({rolled: true});
      expect(connection.contentCalls).toHaveLength(1);
    });

    it('is appended before the connection closes', async () => {
      const harness = await createHarness(connection);

      await runLive(harness, [{close: true, stateDelta: {theme: 'dark'}}]);

      const appended = userEvents(harness.session);
      expect(appended).toHaveLength(1);
      expect(appended[0].actions.stateDelta).toEqual({theme: 'dark'});
      expect(connection.closed).toBe(true);
    });

    it('is dropped when the invocation has no session service', async () => {
      const harness = await createHarness(connection, {
        withSessionService: false,
      });

      await runLive(harness, [{stateDelta: {theme: 'dark'}}]);

      expect(harness.session.events).toHaveLength(0);
      expect(harness.session.state['theme']).toBeUndefined();
    });
  });

  describe('content', () => {
    it('appends no event and sends nothing extra without a state delta', async () => {
      const harness = await createHarness(connection);
      const content: Content = {role: 'user', parts: [{text: 'hello'}]};

      await runLive(harness, [{content}]);

      const appended = userEvents(harness.session);
      expect(appended).toHaveLength(1);
      expect(appended[0].actions.stateDelta).toEqual({});
    });

    it('defaults a missing role to user', async () => {
      const harness = await createHarness(connection);
      const content: Content = {parts: [{text: 'hello'}]};

      await runLive(harness, [{content}]);

      expect(content.role).toBe('user');
      expect(userEvents(harness.session)[0].content?.role).toBe('user');
    });

    it('leaves a function response role unset', async () => {
      const harness = await createHarness(connection);
      const content: Content = {
        parts: [{functionResponse: {name: 'roll', response: {result: 4}}}],
      };

      await runLive(harness, [{content}]);

      expect(content.role).toBeUndefined();
    });

    it('rejects a content that carries a function call', async () => {
      const harness = await createHarness(connection);
      const content: Content = {
        role: 'user',
        parts: [{functionCall: {name: 'roll', args: {}}}],
      };

      await expect(runLive(harness, [{content}])).rejects.toThrow(
        'User message cannot contain function calls.',
      );
    });
  });

  describe('realtime signals', () => {
    it('forwards an audio stream end signal', async () => {
      const harness = await createHarness(connection);

      await runLive(harness, [{audioStreamEnd: true}]);

      expect(connection.audioStreamEndCalls).toBe(1);
      expect(connection.realtimeCalls).toHaveLength(0);
    });

    it('prefers an activity signal over an audio stream end signal', async () => {
      const harness = await createHarness(connection);

      await runLive(harness, [{activityEnd: {}, audioStreamEnd: true}]);

      expect(connection.activityEndCalls).toBe(1);
      expect(connection.audioStreamEndCalls).toBe(0);
    });

    it('prefers an audio stream end signal over a blob', async () => {
      const harness = await createHarness(connection);
      const blob: Blob = {mimeType: 'audio/pcm', data: 'AAAA'};

      await runLive(harness, [{audioStreamEnd: true, blob}]);

      expect(connection.audioStreamEndCalls).toBe(1);
      expect(connection.realtimeCalls).toHaveLength(0);
    });

    it('sends a blob and its accompanying content', async () => {
      const harness = await createHarness(connection);
      const blob: Blob = {mimeType: 'audio/pcm', data: 'AAAA'};
      const content: Content = {role: 'user', parts: [{text: 'and this'}]};

      await runLive(harness, [{blob, content}]);

      expect(connection.realtimeCalls).toEqual([blob]);
      expect(connection.contentCalls).toHaveLength(1);
    });

    it('skips a signal a connection does not implement', async () => {
      const minimal = new MinimalConnection();
      const harness = await createHarness(minimal);

      await runLive(harness, [
        {activityStart: {}},
        {activityEnd: {}},
        {audioStreamEnd: true},
      ]);

      expect(minimal.realtimeCalls).toHaveLength(0);
    });
  });
});
