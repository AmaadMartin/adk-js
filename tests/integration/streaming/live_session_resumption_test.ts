/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  AsyncQueue,
  BaseLlm,
  BaseLlmConnection,
  createEvent,
  Event,
  InMemoryArtifactService,
  InMemorySessionService,
  LiveCloseCode,
  LiveConnectionClosedError,
  LiveRequestQueue,
  LlmAgent,
  LlmRequest,
  LlmResponse,
  RunConfig,
  Runner,
} from '@google/adk';
import {Content, SessionResumptionConfig} from '@google/genai';
import {beforeEach, describe, expect, it} from 'vitest';

const APP_NAME = 'live-resumption-app';
const USER_ID = 'user';
const SESSION_ID = 'session';

/** A live connection that replays one script and records the history sent. */
class ScriptedConnection implements BaseLlmConnection {
  readonly historyCalls: Content[][] = [];
  private readonly queue = new AsyncQueue<LlmResponse>();

  constructor(script: Array<LlmResponse | Error>) {
    for (const entry of script) {
      if (entry instanceof Error) {
        this.queue.fail(entry);
      } else {
        this.queue.push(entry);
      }
    }
  }

  async sendHistory(history: Content[]): Promise<void> {
    this.historyCalls.push(history);
  }
  async sendContent(): Promise<void> {}
  async sendRealtime(): Promise<void> {}

  async *receive(): AsyncGenerator<LlmResponse, void, void> {
    yield* this.queue;
  }

  async close(): Promise<void> {
    this.queue.close();
  }
}

/** A live model that hands out one scripted connection per connect call. */
class ScriptedLiveModel extends BaseLlm {
  readonly connections: ScriptedConnection[] = [];
  readonly configsSeen: Array<LlmRequest['liveConnectConfig']> = [];

  constructor(private readonly scripts: Array<Array<LlmResponse | Error>>) {
    super({model: 'live-test-model'});
  }

  override async *generateContentAsync(): AsyncGenerator<
    LlmResponse,
    void,
    void
  > {
    yield* [];
    throw new Error('generateContentAsync is not part of this scenario.');
  }

  override async connect(llmRequest: LlmRequest): Promise<BaseLlmConnection> {
    this.configsSeen.push(
      JSON.parse(
        JSON.stringify(llmRequest.liveConnectConfig),
      ) as LlmRequest['liveConnectConfig'],
    );
    const connection = new ScriptedConnection(
      this.scripts[this.connections.length] ?? [],
    );
    this.connections.push(connection);
    return connection;
  }
}

describe('live session resumption end to end', () => {
  let sessionService: InMemorySessionService;

  beforeEach(async () => {
    sessionService = new InMemorySessionService();
    const session = await sessionService.createSession({
      appName: APP_NAME,
      userId: USER_ID,
      sessionId: SESSION_ID,
    });
    // An earlier turn gives the flow history to replay on a fresh connection.
    await sessionService.appendEvent({
      session,
      event: createEvent({
        invocationId: 'earlier',
        author: 'user',
        content: {role: 'user', parts: [{text: 'what did I ask before?'}]},
      }),
    });
  });

  async function runLive(
    model: ScriptedLiveModel,
    runConfig?: RunConfig,
  ): Promise<Event[]> {
    const runner = new Runner({
      appName: APP_NAME,
      agent: new LlmAgent({name: 'assistant', model}),
      sessionService,
      artifactService: new InMemoryArtifactService(),
    });
    const queue = new LiveRequestQueue();
    queue.send({content: {role: 'user', parts: [{text: 'hello again'}]}});
    queue.close();

    const events: Event[] = [];
    for await (const event of runner.runLive({
      userId: USER_ID,
      sessionId: SESSION_ID,
      liveRequestQueue: queue,
      runConfig,
    })) {
      events.push(event);
    }
    return events;
  }

  it('resumes from the run config handle, adopts the server handle and ends on a clean close', async () => {
    const sessionResumption: SessionResumptionConfig = {handle: 'stored'};
    const model = new ScriptedLiveModel([
      [
        {liveSessionResumptionUpdate: {newHandle: 'from-server'}},
        new LiveConnectionClosedError(LiveCloseCode.NORMAL, 'server done'),
      ],
      [{turnComplete: true}],
    ]);

    await runLive(model, {sessionResumption});

    expect(model.connections).toHaveLength(2);
    // The stored handle opens the session, so the history is not replayed.
    expect(model.connections[0].historyCalls).toEqual([]);
    expect(model.configsSeen[0]?.sessionResumption?.handle).toBe('stored');
    // The server's handle wins on the reconnect the clean close triggered.
    expect(model.configsSeen[1]?.sessionResumption?.handle).toBe('from-server');
    // The caller's own config never took the flow's writes.
    expect(sessionResumption).toEqual({handle: 'stored'});
  });

  it('replays the history when no handle is stored', async () => {
    const model = new ScriptedLiveModel([
      [
        {content: {role: 'model', parts: [{text: 'hi'}]}},
        new LiveConnectionClosedError(LiveCloseCode.NORMAL, 'server done'),
      ],
    ]);

    const events = await runLive(model);

    expect(model.connections).toHaveLength(1);
    expect(model.connections[0].historyCalls).toHaveLength(1);
    expect(model.configsSeen[0]?.sessionResumption?.handle).toBeUndefined();
    expect(
      events.some((event) => event.content?.parts?.[0]?.text === 'hi'),
    ).toBe(true);
  });
});
