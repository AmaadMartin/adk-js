/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  LiveRequest,
  LiveRequestQueue,
  Logger,
  RunConfig,
  Runner,
} from '@google/adk';
import {Modality} from '@google/genai';
import {RawData, WebSocket} from 'ws';

/** Path the live (bidirectional streaming) WebSocket endpoint listens on. */
export const RUN_LIVE_PATH = '/run_live';

/** WebSocket close codes the `/run_live` endpoint reports. */
export enum LiveCloseCode {
  /** The session named by `session_id` does not exist. */
  PROTOCOL_ERROR = 1002,
  /** The origin is not allowed, or the query is missing or malformed. */
  POLICY_VIOLATION = 1008,
  /** The live run failed. The reason carries the error message. */
  INTERNAL_ERROR = 1011,
}

/**
 * Byte budget for a close reason. The WebSocket control frame that carries it
 * is capped at 125 bytes, two of which hold the close code, and `ws` throws a
 * `RangeError` on a longer reason.
 */
const MAX_CLOSE_REASON_BYTES = 123;

/** Modality tokens the endpoint accepts, matching the adk-python endpoint. */
const LIVE_MODALITIES = new Map<string, Modality>([
  ['TEXT', Modality.TEXT],
  ['AUDIO', Modality.AUDIO],
]);

/** Tokens accepted for a boolean query parameter, lowercased. */
const BOOLEAN_TOKENS = new Map<string, boolean>([
  ['true', true],
  ['false', false],
  ['1', true],
  ['0', false],
]);

/** Hosts treated as loopback when no `allowOrigins` is configured. */
const LOOPBACK_HOSTS = new Set(['localhost', '[::1]']);

/** Matches every address in 127.0.0.0/8, the IPv4 loopback block. */
const IPV4_LOOPBACK_PATTERN = /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/;

/** Keys of a {@link LiveRequest} whose value must be an object. */
const LIVE_REQUEST_OBJECT_KEYS = [
  'content',
  'blob',
  'activityStart',
  'activityEnd',
] as const;

/** Outcome of parsing, carrying the reason so a caller can report it. */
export type ParseResult<T> = {ok: true; value: T} | {ok: false; reason: string};

/**
 * The `/run_live` query, after validation.
 *
 * adk-python also reads `enable_session_resumption`, `save_live_blob` and
 * `explicit_vad_signal`. `RunConfig` has no counterpart field for any of them,
 * so this endpoint ignores them as it ignores any other unknown parameter,
 * rather than carrying three values nothing reads.
 */
export interface RunLiveQuery {
  appName: string;
  userId: string;
  sessionId: string;
  modalities: Modality[];
  proactiveAudio?: boolean;
  enableAffectiveDialog?: boolean;
}

/** Collaborators {@link runLiveSession} drives one connection with. */
export interface RunLiveSessionOptions {
  socket: WebSocket;
  runner: Runner;
  query: RunLiveQuery;
  logger: Logger;
}

/**
 * Shortens a close reason to {@link MAX_CLOSE_REASON_BYTES} bytes without
 * splitting a UTF-8 sequence.
 */
export function truncateCloseReason(reason: string): string {
  const bytes = Buffer.from(reason, 'utf8');
  if (bytes.byteLength <= MAX_CLOSE_REASON_BYTES) {
    return reason;
  }

  // A UTF-8 continuation byte is 0b10xxxxxx. While the byte after the cut is
  // one, the cut lands inside a character, so step back to its lead byte.
  let end = MAX_CLOSE_REASON_BYTES;
  while (end > 0 && (bytes[end] & 0xc0) === 0x80) {
    end--;
  }

  return bytes.subarray(0, end).toString('utf8');
}

/** Reports whether `value` is a plain object rather than an array or null. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Reads the message off a thrown value, as Python's `str(e)` does. */
function errorMessage(error: unknown): string {
  return isRecord(error) && typeof error['message'] === 'string'
    ? error['message']
    : String(error);
}

/** Reads a required string parameter. */
function requireParam(
  params: URLSearchParams,
  name: string,
): ParseResult<string> {
  const value = params.get(name);
  return value
    ? {ok: true, value}
    : {ok: false, reason: `Missing required query parameter: ${name}`};
}

/**
 * Reads the repeated `modalities` parameter, defaulting to `AUDIO` as the
 * adk-python endpoint does.
 */
function parseModalities(params: URLSearchParams): ParseResult<Modality[]> {
  const tokens = params.getAll('modalities');
  if (tokens.length === 0) {
    return {ok: true, value: [Modality.AUDIO]};
  }

  const modalities: Modality[] = [];
  for (const token of tokens) {
    const modality = LIVE_MODALITIES.get(token);
    if (modality === undefined) {
      return {ok: false, reason: `Unsupported modality: ${token}`};
    }
    modalities.push(modality);
  }

  return {ok: true, value: modalities};
}

/** Reads an optional boolean parameter, rejecting a token that is not one. */
function parseBoolean(
  params: URLSearchParams,
  name: string,
): ParseResult<boolean | undefined> {
  const raw = params.get(name);
  if (raw === null) {
    return {ok: true, value: undefined};
  }

  const value = BOOLEAN_TOKENS.get(raw.toLowerCase());
  return value === undefined
    ? {ok: false, reason: `Invalid boolean for ${name}: ${raw}`}
    : {ok: true, value};
}

/**
 * Validates the `/run_live` query string.
 *
 * The parameter names are snake_case because the ADK dev UI drives the
 * adk-python server with the same names.
 */
export function parseRunLiveQuery(
  params: URLSearchParams,
): ParseResult<RunLiveQuery> {
  const appName = requireParam(params, 'app_name');
  if (!appName.ok) {
    return appName;
  }
  const userId = requireParam(params, 'user_id');
  if (!userId.ok) {
    return userId;
  }
  const sessionId = requireParam(params, 'session_id');
  if (!sessionId.ok) {
    return sessionId;
  }
  const modalities = parseModalities(params);
  if (!modalities.ok) {
    return modalities;
  }
  const proactiveAudio = parseBoolean(params, 'proactive_audio');
  if (!proactiveAudio.ok) {
    return proactiveAudio;
  }
  const enableAffectiveDialog = parseBoolean(params, 'enable_affective_dialog');
  if (!enableAffectiveDialog.ok) {
    return enableAffectiveDialog;
  }

  return {
    ok: true,
    value: {
      appName: appName.value,
      userId: userId.value,
      sessionId: sessionId.value,
      modalities: modalities.value,
      proactiveAudio: proactiveAudio.value,
      enableAffectiveDialog: enableAffectiveDialog.value,
    },
  };
}

/** Reports whether an origin's host is a loopback address. */
function isLoopbackOrigin(origin: string): boolean {
  let hostname: string;
  try {
    ({hostname} = new URL(origin));
  } catch {
    return false;
  }

  return LOOPBACK_HOSTS.has(hostname) || IPV4_LOOPBACK_PATTERN.test(hostname);
}

/**
 * Decides whether a WebSocket handshake from `origin` may proceed.
 *
 * A request with no `Origin` header is allowed: non-browser clients send none,
 * and only a browser attaches one the user did not choose. When the operator
 * configured `allowOrigins`, that decides. Otherwise only a loopback origin is
 * allowed, because a WebSocket handshake is exempt from the same-origin
 * policy, so a default-open socket would let any page the developer visits
 * drive their agent.
 */
export function isOriginAllowed(
  origin: string | undefined,
  allowOrigins?: string,
): boolean {
  if (origin === undefined) {
    return true;
  }
  if (allowOrigins) {
    return allowOrigins === '*' || allowOrigins === origin;
  }

  return isLoopbackOrigin(origin);
}

/**
 * Reports whether `value` is a {@link LiveRequest} envelope.
 *
 * Only the envelope is checked. The payloads are `@google/genai` types, and
 * the model client validates them, so duplicating their schemas here would
 * reject content the model accepts.
 */
export function isLiveRequest(value: unknown): value is LiveRequest {
  if (!isRecord(value)) {
    return false;
  }

  const hasClose = 'close' in value;
  if (hasClose && typeof value['close'] !== 'boolean') {
    return false;
  }

  const objectKeys = LIVE_REQUEST_OBJECT_KEYS.filter((key) => key in value);
  if (objectKeys.some((key) => !isRecord(value[key]))) {
    return false;
  }

  return hasClose || objectKeys.length > 0;
}

/** Builds the run config the live query asks for. */
export function buildLiveRunConfig(query: RunLiveQuery): RunConfig {
  return {
    responseModalities: query.modalities,
    proactivity:
      query.proactiveAudio === undefined
        ? undefined
        : {proactiveAudio: query.proactiveAudio},
    enableAffectiveDialog: query.enableAffectiveDialog,
  };
}

/** Decodes an inbound frame as UTF-8 text. */
function frameToText(data: RawData): string {
  return new TextDecoder().decode(
    Array.isArray(data) ? Buffer.concat(data) : data,
  );
}

/** Parses one inbound frame, returning undefined when it is not a request. */
function parseLiveRequest(frame: string): LiveRequest | undefined {
  let value: unknown;
  try {
    value = JSON.parse(frame);
  } catch {
    return undefined;
  }

  return isLiveRequest(value) ? value : undefined;
}

/**
 * Drives one live connection: the runner's events go out as JSON frames, and
 * inbound frames go onto `liveRequestQueue`.
 *
 * The queue lives and dies with the connection, so this owns it: it is created
 * here and closed on every exit path.
 *
 * A frame that is not a valid {@link LiveRequest} is logged and dropped, and
 * the socket stays open. A client disconnect ends the run quietly; any other
 * error propagates to the caller, which owns the close frame.
 */
export async function runLiveSession(
  options: RunLiveSessionOptions,
): Promise<void> {
  const {socket, runner, query, logger} = options;
  const liveRequestQueue = new LiveRequestQueue();
  const abortController = new AbortController();
  let disconnected = false;

  const onMessage = (data: RawData) => {
    const frame = frameToText(data);
    const request = parseLiveRequest(frame);
    if (!request) {
      logger.error(`Dropping an invalid live request frame: ${frame}`);
      return;
    }
    liveRequestQueue.send(request);
  };
  const onClose = () => {
    disconnected = true;
    abortController.abort();
    liveRequestQueue.close();
  };
  const onError = (error: Error) => {
    logger.error(`Live socket error: ${errorMessage(error)}`);
  };

  socket.on('message', onMessage);
  socket.on('close', onClose);
  socket.on('error', onError);

  try {
    for await (const event of runner.runLive({
      userId: query.userId,
      sessionId: query.sessionId,
      liveRequestQueue,
      runConfig: buildLiveRunConfig(query),
      abortSignal: abortController.signal,
    })) {
      if (socket.readyState !== WebSocket.OPEN) {
        break;
      }
      socket.send(JSON.stringify(event));
    }
    socket.close();
  } catch (e: unknown) {
    // A disconnect aborts the run mid-flight, so whatever the run raises on
    // the way out reports the disconnect, not a fault.
    if (!disconnected) {
      throw e;
    }
    logger.debug('The client disconnected from the live session.');
  } finally {
    socket.off('message', onMessage);
    socket.off('close', onClose);
    socket.off('error', onError);
    abortController.abort();
    liveRequestQueue.close();
  }
}

/**
 * Closes `socket` with {@link LiveCloseCode.INTERNAL_ERROR} and the error's
 * message, shortened to fit a close frame.
 */
export function closeWithError(
  socket: WebSocket,
  error: unknown,
  logger: Logger,
): void {
  const reason = errorMessage(error);
  logger.error(`Error during the live session: ${reason}`);
  socket.close(LiveCloseCode.INTERNAL_ERROR, truncateCloseReason(reason));
}
