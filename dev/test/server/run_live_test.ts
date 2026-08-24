/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  createEvent,
  Event,
  InMemorySessionService,
  LiveRequestQueue,
  LlmAgent,
  Logger,
  Runner,
} from '@google/adk';
import {Content, Modality} from '@google/genai';
import {once} from 'node:events';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {WebSocket, WebSocketServer} from 'ws';

import {
  buildLiveRunConfig,
  closeWithError,
  isLiveRequest,
  isOriginAllowed,
  parseRunLiveQuery,
  runLiveSession,
  truncateCloseReason,
} from '../../src/server/run_live.js';

/** Parses `query` and fails the test when it was rejected. */
function parseOrFail(query: string) {
  const result = parseRunLiveQuery(new URLSearchParams(query));
  if (!result.ok) {
    expect.fail(`expected ${query} to parse, got: ${result.reason}`);
  }
  return result.value;
}

/** Parses `query` and fails the test when it was accepted. */
function rejectionReason(query: string): string {
  const result = parseRunLiveQuery(new URLSearchParams(query));
  if (result.ok) {
    expect.fail(`expected ${query} to be rejected`);
  }
  return result.reason;
}

const REQUIRED = 'app_name=a&user_id=u&session_id=s';

describe('parseRunLiveQuery', () => {
  it('reads the three required parameters', () => {
    const query = parseOrFail(REQUIRED);

    expect(query.appName).toBe('a');
    expect(query.userId).toBe('u');
    expect(query.sessionId).toBe('s');
  });

  it('defaults modalities to AUDIO and leaves the options unset', () => {
    const query = parseOrFail(REQUIRED);

    expect(query.modalities).toEqual([Modality.AUDIO]);
    expect(query.proactiveAudio).toBeUndefined();
    expect(query.enableAffectiveDialog).toBeUndefined();
  });

  it('reads a repeated modalities parameter in order', () => {
    const query = parseOrFail(`${REQUIRED}&modalities=TEXT&modalities=AUDIO`);

    expect(query.modalities).toEqual([Modality.TEXT, Modality.AUDIO]);
  });

  it.each([
    ['true', true],
    ['false', false],
    ['TRUE', true],
    ['1', true],
    ['0', false],
  ])('reads proactive_audio=%s as %s', (token, expected) => {
    const query = parseOrFail(`${REQUIRED}&proactive_audio=${token}`);

    expect(query.proactiveAudio).toBe(expected);
  });

  it.each([
    ['true', true],
    ['false', false],
  ])('reads enable_affective_dialog=%s as %s', (token, expected) => {
    const query = parseOrFail(`${REQUIRED}&enable_affective_dialog=${token}`);

    expect(query.enableAffectiveDialog).toBe(expected);
  });

  it.each([
    'enable_session_resumption',
    'save_live_blob',
    'explicit_vad_signal',
  ])('accepts %s, which has no RunConfig counterpart yet', (name) => {
    expect(parseOrFail(`${REQUIRED}&${name}=true`).appName).toBe('a');
    expect(parseOrFail(`${REQUIRED}&${name}=false`).appName).toBe('a');
  });

  it.each(['app_name', 'user_id', 'session_id'])(
    'rejects a query with no %s',
    (name) => {
      const query = new URLSearchParams(REQUIRED);
      query.delete(name);

      const result = parseRunLiveQuery(query);

      expect(result).toEqual({
        ok: false,
        reason: `Missing required query parameter: ${name}`,
      });
    },
  );

  it('rejects an empty required parameter', () => {
    expect(rejectionReason('app_name=&user_id=u&session_id=s')).toBe(
      'Missing required query parameter: app_name',
    );
  });

  it('rejects an unsupported modality token', () => {
    expect(rejectionReason(`${REQUIRED}&modalities=VIDEO`)).toBe(
      'Unsupported modality: VIDEO',
    );
  });

  it('rejects a lowercase modality token', () => {
    expect(rejectionReason(`${REQUIRED}&modalities=audio`)).toBe(
      'Unsupported modality: audio',
    );
  });

  it.each([
    'proactive_audio',
    'enable_affective_dialog',
    'enable_session_resumption',
    'save_live_blob',
    'explicit_vad_signal',
  ])('rejects an unparseable %s', (name) => {
    expect(rejectionReason(`${REQUIRED}&${name}=maybe`)).toBe(
      `Invalid boolean for ${name}: maybe`,
    );
  });

  it('rejects a boolean token that names an Object.prototype member', () => {
    expect(rejectionReason(`${REQUIRED}&save_live_blob=constructor`)).toBe(
      'Invalid boolean for save_live_blob: constructor',
    );
  });
});

describe('isOriginAllowed', () => {
  it('allows a request that sends no Origin header', () => {
    expect(isOriginAllowed(undefined)).toBe(true);
    expect(isOriginAllowed(undefined, 'http://localhost:4200')).toBe(true);
  });

  it('allows any origin when allowOrigins is a wildcard', () => {
    expect(isOriginAllowed('https://evil.com', '*')).toBe(true);
  });

  it('allows an origin that matches allowOrigins exactly', () => {
    expect(
      isOriginAllowed('http://localhost:4200', 'http://localhost:4200'),
    ).toBe(true);
  });

  it('refuses an origin that does not match allowOrigins', () => {
    expect(isOriginAllowed('https://evil.com', 'http://localhost:4200')).toBe(
      false,
    );
  });

  it.each([
    'http://localhost:4200',
    'http://127.0.0.1:8000',
    'https://127.9.9.9',
    'http://[::1]:8000',
  ])('allows the loopback origin %s when allowOrigins is unset', (origin) => {
    expect(isOriginAllowed(origin)).toBe(true);
  });

  it.each(['https://evil.com', 'http://192.168.0.1', 'http://127.example.com'])(
    'refuses the remote origin %s when allowOrigins is unset',
    (origin) => {
      expect(isOriginAllowed(origin)).toBe(false);
    },
  );

  it('refuses an origin that is not a URL', () => {
    expect(isOriginAllowed('null')).toBe(false);
  });
});

describe('truncateCloseReason', () => {
  it('leaves a short reason unchanged', () => {
    expect(truncateCloseReason('Session not found')).toBe('Session not found');
  });

  it('leaves a reason of exactly 123 bytes unchanged', () => {
    const reason = 'a'.repeat(123);

    expect(truncateCloseReason(reason)).toBe(reason);
  });

  it('cuts a long ASCII reason to exactly 123 bytes', () => {
    const result = truncateCloseReason('a'.repeat(200));

    expect(Buffer.byteLength(result, 'utf8')).toBe(123);
    expect(result).toBe('a'.repeat(123));
  });

  it('never splits a two-byte character', () => {
    // 62 * 2 bytes = 124, so a byte-blind cut at 123 lands mid-character.
    const result = truncateCloseReason('é'.repeat(62));

    expect(Buffer.byteLength(result, 'utf8')).toBe(122);
    expect(result).toBe('é'.repeat(61));
    expect(result).not.toContain('\ufffd');
  });

  it('never splits a four-byte emoji', () => {
    const result = truncateCloseReason('😀'.repeat(40));

    expect(Buffer.byteLength(result, 'utf8')).toBeLessThanOrEqual(123);
    expect(result).toBe('😀'.repeat(30));
    expect(result).not.toContain('\ufffd');
    expect(Buffer.from(result, 'utf8').toString('utf8')).toBe(result);
  });
});

describe('isLiveRequest', () => {
  it.each([
    ['content', {content: {role: 'user', parts: [{text: 'hi'}]}}],
    ['blob', {blob: {mimeType: 'audio/pcm;rate=16000', data: 'AAAA'}}],
    ['activityStart', {activityStart: {}}],
    ['activityEnd', {activityEnd: {}}],
    ['close', {close: true}],
  ])('accepts an envelope carrying %s', (_name, value) => {
    expect(isLiveRequest(value)).toBe(true);
  });

  it('accepts close set to false', () => {
    expect(isLiveRequest({close: false})).toBe(true);
  });

  it.each([
    ['an array', [{close: true}]],
    ['a string', 'close'],
    ['a number', 1],
    ['null', null],
    ['an empty object', {}],
    ['an unrecognized key', {foo: 'bar'}],
    ['a non-boolean close', {close: 'yes'}],
    ['a non-object content', {content: 'hi'}],
    ['a null blob', {blob: null}],
    ['an array activityStart', {activityStart: []}],
  ])('refuses %s', (_name, value) => {
    expect(isLiveRequest(value)).toBe(false);
  });
});

describe('buildLiveRunConfig', () => {
  const base = {appName: 'a', userId: 'u', sessionId: 's'};

  it('forwards the modalities', () => {
    const config = buildLiveRunConfig({...base, modalities: [Modality.TEXT]});

    expect(config.responseModalities).toEqual([Modality.TEXT]);
  });

  it('leaves proactivity unset when proactive_audio was absent', () => {
    const config = buildLiveRunConfig({...base, modalities: [Modality.AUDIO]});

    expect(config.proactivity).toBeUndefined();
    expect(config.enableAffectiveDialog).toBeUndefined();
  });

  it.each([true, false])('wraps proactiveAudio=%s in a config', (value) => {
    const config = buildLiveRunConfig({
      ...base,
      modalities: [Modality.AUDIO],
      proactiveAudio: value,
    });

    expect(config.proactivity).toEqual({proactiveAudio: value});
  });

  it('forwards enableAffectiveDialog', () => {
    const config = buildLiveRunConfig({
      ...base,
      modalities: [Modality.AUDIO],
      enableAffectiveDialog: true,
    });

    expect(config.enableAffectiveDialog).toBe(true);
  });
});

/** Logger that records what the session reported, so a test can assert on it. */
class RecordingLogger implements Logger {
  readonly errors: string[] = [];

  log(): void {}
  debug(): void {}
  info(): void {}
  warn(): void {}
  setLogLevel(): void {}

  error(...args: unknown[]): void {
    this.errors.push(args.join(' '));
  }
}

/** A live event echoing whatever content arrived on the queue. */
function echoEvent(content: Content | undefined): Event {
  return createEvent({
    invocationId: 'liveInvocation',
    author: 'liveAgent',
    content,
  });
}

/** A listening WebSocket server with one connected client. */
interface SocketPair {
  wss: WebSocketServer;
  serverSocket: WebSocket;
  clientSocket: WebSocket;
}

/** Starts a real WebSocket server and connects one client to it. */
async function startSocketPair(): Promise<SocketPair> {
  const wss = new WebSocketServer({port: 0});
  await once(wss, 'listening');

  const address = wss.address();
  if (typeof address === 'string' || address === null) {
    expect.fail('expected the test server to bind a TCP port');
  }

  const clientSocket = new WebSocket(`ws://localhost:${address.port}`);
  const [serverSocket] = await once(wss, 'connection');
  await once(clientSocket, 'open');

  return {wss, serverSocket, clientSocket};
}

/** Terminates both ends of a socket pair and closes the server. */
async function stopSocketPair(pair: SocketPair): Promise<void> {
  pair.clientSocket.terminate();
  pair.serverSocket.terminate();
  pair.wss.close();
  await once(pair.wss, 'close');
}

describe('runLiveSession', () => {
  let pair: SocketPair;
  let serverSocket: WebSocket;
  let clientSocket: WebSocket;
  let logger: RecordingLogger;
  let runner: Runner;
  let liveRequestQueue: LiveRequestQueue;

  beforeEach(async () => {
    logger = new RecordingLogger();
    liveRequestQueue = new LiveRequestQueue();
    runner = new Runner({
      appName: 'testApp',
      agent: new LlmAgent({name: 'liveAgent', description: 'live agent'}),
      sessionService: new InMemorySessionService(),
    });

    pair = await startSocketPair();
    ({serverSocket, clientSocket} = pair);
  });

  afterEach(async () => {
    await stopSocketPair(pair);
    vi.restoreAllMocks();
  });

  /** Runs `script` in place of the runner's live loop. */
  function drive(
    script: (params: {
      liveRequestQueue: LiveRequestQueue;
      abortSignal?: AbortSignal;
    }) => AsyncGenerator<Event, void, undefined>,
  ): Promise<void> {
    vi.spyOn(runner, 'runLive').mockImplementation(script);
    return runLiveSession({
      socket: serverSocket,
      runner,
      query: {
        appName: 'testApp',
        userId: 'testUser',
        sessionId: 'liveSession',
        modalities: [Modality.TEXT],
      },
      liveRequestQueue,
      logger,
    });
  }

  it('reads a frame delivered as a list of buffers', async () => {
    const session = drive(async function* (params) {
      const request = await params.liveRequestQueue.get(params.abortSignal);
      yield echoEvent(request.content);
    });

    serverSocket.emit(
      'message',
      [
        Buffer.from('{"content":{"role":"user","par'),
        Buffer.from('ts":[{"text":"split"}]}}'),
      ],
      true,
    );
    const [frame] = await once(clientSocket, 'message');
    await session;

    const event = JSON.parse(frame.toString()) as Event;
    expect(event.content?.parts?.[0].text).toBe('split');
  });

  it('stops sending once the socket is no longer open', async () => {
    const frames: string[] = [];
    clientSocket.on('message', (data) => frames.push(data.toString()));

    await drive(async function* () {
      yield echoEvent({role: 'model', parts: [{text: 'first'}]});
      serverSocket.close();
      await once(serverSocket, 'close');
      yield echoEvent({role: 'model', parts: [{text: 'second'}]});
    });

    expect(frames).toHaveLength(1);
    expect((JSON.parse(frames[0]) as Event).content?.parts?.[0].text).toBe(
      'first',
    );
  });

  it('reports a socket error through the logger', async () => {
    const session = drive(async function* (params) {
      const request = await params.liveRequestQueue.get(params.abortSignal);
      yield echoEvent(request.content);
    });

    serverSocket.emit('error', new Error('connection reset by peer'));
    liveRequestQueue.close();
    await session;

    expect(logger.errors).toEqual([
      'Live socket error: connection reset by peer',
    ]);
  });

  it('drops an unparseable frame without closing the socket', async () => {
    const session = drive(async function* (params) {
      const request = await params.liveRequestQueue.get(params.abortSignal);
      yield echoEvent(request.content);
    });

    clientSocket.send('not json');
    clientSocket.send(
      JSON.stringify({content: {role: 'user', parts: [{text: 'kept'}]}}),
    );
    const [frame] = await once(clientSocket, 'message');
    await session;

    const event = JSON.parse(frame.toString()) as Event;
    expect(event.content?.parts?.[0].text).toBe('kept');
    expect(logger.errors).toEqual([
      'Dropping an invalid live request frame: not json',
    ]);
  });

  it('drops valid JSON that is not a live request', async () => {
    const session = drive(async function* (params) {
      const request = await params.liveRequestQueue.get(params.abortSignal);
      yield echoEvent(request.content);
    });

    clientSocket.send('{"foo":1}');
    clientSocket.send(
      JSON.stringify({content: {role: 'user', parts: [{text: 'kept'}]}}),
    );
    await once(clientSocket, 'message');
    await session;

    expect(logger.errors).toEqual([
      'Dropping an invalid live request frame: {"foo":1}',
    ]);
  });

  it('reports a client disconnect at debug level, not as an error', async () => {
    const session = drive(async function* (params) {
      const request = await params.liveRequestQueue.get(params.abortSignal);
      yield echoEvent(request.content);
    });

    clientSocket.close();
    await session;

    expect(logger.errors).toEqual([]);
  });
});

describe('closeWithError', () => {
  it('closes with 1011 and a reason that fits a close frame', async () => {
    const pair = await startSocketPair();
    const logger = new RecordingLogger();

    try {
      closeWithError(pair.serverSocket, new Error('é'.repeat(200)), logger);
      const [code, reason] = await once(pair.clientSocket, 'close');

      expect(code).toBe(1011);
      expect(Buffer.byteLength(reason.toString(), 'utf8')).toBe(122);
      expect(logger.errors).toHaveLength(1);
    } finally {
      await stopSocketPair(pair);
    }
  });
});
