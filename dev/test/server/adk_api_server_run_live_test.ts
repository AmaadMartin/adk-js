/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  BaseSessionService,
  createEvent,
  Event,
  InMemoryArtifactService,
  InMemoryMemoryService,
  InMemorySessionService,
  InvocationContext,
  LiveRequest,
  LlmAgent,
  RunnableRoot,
} from '@google/adk';
import {Part} from '@google/genai';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

import {AdkApiServer} from '../../src/server/adk_api_server.js';
import {AgentFile, AgentLoader} from '../../src/utils/agent_loader.js';

/** Path the live (bidirectional streaming) endpoint listens on. */
const RUN_LIVE_PATH = '/run_live';

const LIVE_APP_NAME = 'testApp';
const ECHO_APP_NAME = 'echoApp';
const LIVE_USER_ID = 'testUser';
const LIVE_SESSION_ID = 'liveSession';

/**
 * The query adk-python's endpoint reads. Its parameters are snake_case, which
 * is the contract the dev UI already speaks, so this port keeps that spelling
 * rather than the camelCase the JSON request bodies use.
 */
function liveQuery(appName: string): string {
  return `app_name=${appName}&user_id=${LIVE_USER_ID}&session_id=${LIVE_SESSION_ID}`;
}

const LIVE_QUERY = liveQuery(LIVE_APP_NAME);
const ECHO_QUERY = liveQuery(ECHO_APP_NAME);

/** Python's `b"\x00\xFF"`. `Blob.data` is base64 in `@google/genai`. */
const LIVE_AUDIO_BASE64 = 'AP8=';

/** Mime type the model reports on the audio it streams back. */
const MODEL_AUDIO_MIME_TYPE = 'audio/pcm;rate=24000';

/** Frames the client sends up, matching the two the Python test sends. */
const TEXT_REQUEST: LiveRequest = {
  content: {role: 'user', parts: [{text: 'Hello via WebSocket'}]},
};
const BLOB_REQUEST: LiveRequest = {
  blob: {mimeType: 'audio/pcm', data: LIVE_AUDIO_BASE64},
};

/** How many frames {@link EchoLiveAgent} reads before it ends the run. */
const ECHOED_REQUEST_COUNT = 2;

/**
 * Bound on every socket wait. It sits under Vitest's 5s per-test budget so a
 * missing endpoint reports what it was waiting for instead of timing out.
 */
const SOCKET_TIMEOUT_MS = 2000;

/**
 * Yields the three events adk-python scripts onto `Runner.run_live` in
 * `test_websocket_endpoint`: a text reply, model audio, and an interruption.
 */
class LiveTestAgent extends LlmAgent {
  protected override async *runLiveImpl(
    context: InvocationContext,
  ): AsyncGenerator<Event, void, void> {
    yield createEvent({
      invocationId: context.invocationId,
      author: this.name,
      branch: context.branch,
      content: {role: 'model', parts: [{text: 'LLM reply'}]},
    });

    yield createEvent({
      invocationId: context.invocationId,
      author: this.name,
      branch: context.branch,
      content: {
        role: 'model',
        parts: [
          {
            inlineData: {
              mimeType: MODEL_AUDIO_MIME_TYPE,
              data: LIVE_AUDIO_BASE64,
            },
          },
        ],
      },
    });

    yield createEvent({
      invocationId: context.invocationId,
      author: this.name,
      branch: context.branch,
      interrupted: true,
    });
  }
}

/** The parts a model reply carries when it echoes an inbound frame back. */
function echoedParts(request: LiveRequest): Part[] {
  return request.blob
    ? [{inlineData: request.blob}]
    : (request.content?.parts ?? []);
}

/**
 * Echoes back every frame the client sends up, so a test can assert that the
 * endpoint parses inbound frames into the agent's live request queue at all.
 * It reads {@link ECHOED_REQUEST_COUNT} frames and then ends the run.
 */
class EchoLiveAgent extends LlmAgent {
  protected override async *runLiveImpl(
    context: InvocationContext,
  ): AsyncGenerator<Event, void, void> {
    const liveRequestQueue = context.liveRequestQueue;
    if (!liveRequestQueue) {
      return;
    }

    for (let read = 0; read < ECHOED_REQUEST_COUNT; read++) {
      const request = await liveRequestQueue.get(context.abortSignal);
      yield createEvent({
        invocationId: context.invocationId,
        author: this.name,
        branch: context.branch,
        content: {role: 'model', parts: echoedParts(request)},
      });
    }
  }
}

/** Serves one agent without reading or compiling a file. */
class LiveAgentFile extends AgentFile {
  constructor(private readonly liveAgent: RunnableRoot) {
    super('live_test_agent.ts');
  }

  override load(): Promise<RunnableRoot> {
    return Promise.resolve(this.liveAgent);
  }
}

/** Loader that serves the two apps the live tests drive. */
class LiveAgentLoader extends AgentLoader {
  private readonly agentFiles: Record<string, AgentFile> = {
    [LIVE_APP_NAME]: new LiveAgentFile(
      new LiveTestAgent({
        name: 'liveTestAgent',
        description: 'agent that scripts the adk-python live events',
      }),
    ),
    [ECHO_APP_NAME]: new LiveAgentFile(
      new EchoLiveAgent({
        name: 'echoLiveAgent',
        description: 'agent that echoes the frames the client sends up',
      }),
    ),
  };

  override listAgents(): Promise<string[]> {
    return Promise.resolve(Object.keys(this.agentFiles));
  }

  override getAgentFile(agentName: string): Promise<AgentFile> {
    return Promise.resolve(this.agentFiles[agentName]);
  }
}

/** How the server closed a live socket. */
interface LiveCloseInfo {
  code: number;
  reason: string;
}

/**
 * Every client a test opened. The `afterEach` hook closes them all, so a
 * socket cannot outlive the test that opened it even when that test fails.
 */
const openClients: LiveClient[] = [];

/**
 * A client of the dev server's `/run_live` endpoint.
 *
 * It buffers every frame the server sends, so a test that asserts on one
 * event cannot miss the next one while it does so.
 */
class LiveClient {
  /** Events received so far, in arrival order. */
  readonly events: Event[] = [];
  /** Resolves once the server accepts the upgrade, rejects when it refuses. */
  readonly opened: Promise<void>;
  /** Resolves with the code and reason the server closed with. */
  readonly closed: Promise<LiveCloseInfo>;
  private readonly socket: WebSocket;

  constructor(baseUrl: string, query: string) {
    const url = new URL(RUN_LIVE_PATH, baseUrl);
    url.protocol = 'ws:';
    url.search = query;
    this.socket = new WebSocket(url);
    openClients.push(this);

    this.socket.addEventListener('message', (message) => {
      this.events.push(JSON.parse(String(message.data)) as Event);
    });

    this.closed = new Promise((resolve) => {
      this.socket.addEventListener(
        'close',
        (close) => resolve({code: close.code, reason: close.reason}),
        {once: true},
      );
    });

    this.opened = new Promise((resolve, reject) => {
      this.socket.addEventListener('open', () => resolve(), {once: true});
      this.socket.addEventListener(
        'error',
        () =>
          reject(
            new Error(
              `The dev server refused a WebSocket upgrade on ${RUN_LIVE_PATH}`,
            ),
          ),
        {once: true},
      );
    });
  }

  send(request: LiveRequest): void {
    this.socket.send(JSON.stringify(request));
  }

  /** Waits for the event at `index` in the stream and returns it. */
  eventAt(index: number): Promise<Event> {
    return vi.waitUntil(() => this.events[index], {
      timeout: SOCKET_TIMEOUT_MS,
    });
  }

  close(): void {
    this.socket.close();
  }
}

/** Rejects when `promise` does not settle within {@link SOCKET_TIMEOUT_MS}. */
async function withTimeout<T>(promise: Promise<T>, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expiry = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () =>
        reject(
          new Error(
            `Timed out after ${SOCKET_TIMEOUT_MS}ms waiting for ${what}`,
          ),
        ),
      SOCKET_TIMEOUT_MS,
    );
  });

  try {
    return await Promise.race([promise, expiry]);
  } finally {
    clearTimeout(timer);
  }
}

describe('AdkApiServer live endpoint', () => {
  let sessionService: BaseSessionService;
  let server: AdkApiServer;

  beforeEach(async () => {
    sessionService = new InMemorySessionService();
    server = new AdkApiServer({
      agentLoader: new LiveAgentLoader(),
      sessionService,
      memoryService: new InMemoryMemoryService(),
      artifactService: new InMemoryArtifactService(),
    });
    await server.start();
  });

  afterEach(async () => {
    for (const client of openClients.splice(0)) {
      client.close();
    }
    // Bounded, because a server that leaves a live socket half-open never
    // finishes closing, and a plain await reports only a hook timeout.
    await withTimeout(server.stop(), 'the server to close its connections');
  });

  describe('run_live', () => {
    it('streams the live text reply of the agent', async () => {
      await sessionService.createSession({
        appName: LIVE_APP_NAME,
        userId: LIVE_USER_ID,
        sessionId: LIVE_SESSION_ID,
      });

      const client = new LiveClient(server.url, LIVE_QUERY);
      await client.opened;
      client.send(TEXT_REQUEST);

      const event = await client.eventAt(0);

      expect(event.content?.parts?.[0].text).toBe('LLM reply');
    });

    it('streams model audio with its mime type and payload intact', async () => {
      await sessionService.createSession({
        appName: LIVE_APP_NAME,
        userId: LIVE_USER_ID,
        sessionId: LIVE_SESSION_ID,
      });

      const client = new LiveClient(server.url, LIVE_QUERY);
      await client.opened;
      client.send(TEXT_REQUEST);
      client.send(BLOB_REQUEST);

      const event = await client.eventAt(1);

      expect(event.content?.parts?.[0].inlineData?.mimeType).toBe(
        MODEL_AUDIO_MIME_TYPE,
      );
      expect(event.content?.parts?.[0].inlineData?.data).toBe(
        LIVE_AUDIO_BASE64,
      );
    });

    it('forwards an interrupted event that carries no content', async () => {
      await sessionService.createSession({
        appName: LIVE_APP_NAME,
        userId: LIVE_USER_ID,
        sessionId: LIVE_SESSION_ID,
      });

      const client = new LiveClient(server.url, LIVE_QUERY);
      await client.opened;
      client.send(TEXT_REQUEST);
      client.send(BLOB_REQUEST);

      const event = await client.eventAt(2);

      expect(event.interrupted).toBe(true);
      expect(event.content).toBeUndefined();
    });

    it('feeds the frames the client sends into the live request queue', async () => {
      await sessionService.createSession({
        appName: ECHO_APP_NAME,
        userId: LIVE_USER_ID,
        sessionId: LIVE_SESSION_ID,
      });

      const client = new LiveClient(server.url, ECHO_QUERY);
      await client.opened;
      client.send(TEXT_REQUEST);
      client.send(BLOB_REQUEST);

      const text = await client.eventAt(0);
      const audio = await client.eventAt(1);

      expect(text.content?.parts?.[0].text).toBe('Hello via WebSocket');
      expect(audio.content?.parts?.[0].inlineData?.mimeType).toBe('audio/pcm');
      expect(audio.content?.parts?.[0].inlineData?.data).toBe(
        LIVE_AUDIO_BASE64,
      );
    });

    it('closes with 1002 when the session does not exist', async () => {
      const client = new LiveClient(server.url, LIVE_QUERY);
      await client.opened;

      const {code, reason} = await withTimeout(
        client.closed,
        'the server to close the socket',
      );

      expect(code).toBe(1002);
      expect(reason).toBe('Session not found');
    });
  });
});
