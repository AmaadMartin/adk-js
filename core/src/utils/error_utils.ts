/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Helpers for inspecting arbitrary thrown values: turning them into readable,
 * root-cause messages, so that wrapped, aggregated or HTTP-flavoured failures
 * are not reduced to an empty or generic string when they are reported, and
 * telling a cancellation apart from a real failure.
 */

import {isRecord} from './type_utils.js';

/**
 * Maximum number of characters of a request or response body kept in a log or
 * an error message before it is truncated. Bounds both log volume and the
 * exposure of potentially sensitive payloads. Shared through
 * {@link truncateBody}, so that a body reported through an error and the same
 * body captured for debugging are cut at the same point.
 */
export const MAX_LOG_BODY_LENGTH = 1000;

/** Marker appended to a body that exceeds {@link MAX_LOG_BODY_LENGTH}. */
export const TRUNCATION_MARKER = '... [truncated]';

/** Returned by {@link formatError} when the input carries no usable message. */
const UNKNOWN_ERROR = 'Unknown error';

/** Lowest and highest values treated as an HTTP status code. */
const MIN_HTTP_STATUS = 100;
const MAX_HTTP_STATUS = 599;

/**
 * Error `name` values that mean the caller cancelled the operation rather than
 * the operation failing. An aborted `AbortSignal` produces `AbortError`, and
 * `AbortSignal.timeout` produces `TimeoutError`.
 */
const CANCELLATION_ERROR_NAMES = new Set(['AbortError', 'TimeoutError']);

/**
 * Error names that mean a deadline expired. `TimeoutError` is what
 * `AbortSignal.timeout` aborts with; the rest are undici's transport errors,
 * which Node's `fetch` reports as the `cause` of a `TypeError`.
 */
const TIMEOUT_ERROR_NAMES: ReadonlySet<string> = new Set([
  'TimeoutError',
  'ConnectTimeoutError',
  'HeadersTimeoutError',
  'BodyTimeoutError',
]);

/** Error codes that mean a deadline expired. */
const TIMEOUT_ERROR_CODES: ReadonlySet<string> = new Set([
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
  'ETIMEDOUT',
]);

/**
 * Narrows `value` to an indexable record, or returns `undefined` when `value`
 * is null or not a non-null object. Used to safely inspect duck-typed error
 * shapes, and parsed JSON, without resorting to `any`.
 */
export function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object'
    ? (value as Record<string, unknown>)
    : undefined;
}

/** Returns the first argument that is a string, or `undefined` if none are. */
function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === 'string') {
      return value;
    }
  }
  return undefined;
}

/**
 * Truncates a body to {@link MAX_LOG_BODY_LENGTH} characters, appending a
 * marker when it did.
 *
 * @param body The request or response body to bound.
 * @return The body, at most {@link MAX_LOG_BODY_LENGTH} characters plus the
 *   marker.
 */
export function truncateBody(body: string): string {
  return body.length > MAX_LOG_BODY_LENGTH
    ? body.slice(0, MAX_LOG_BODY_LENGTH) + TRUNCATION_MARKER
    : body;
}

/** Returns the plain, non-recursive message for a single value. */
function baseMessage(err: unknown): string {
  if (err instanceof Error) {
    return err.message;
  }
  if (typeof err === 'string') {
    return err;
  }
  return String(err);
}

/**
 * Extracts synchronously-available HTTP details (status, status text and a
 * truncated response body) from a duck-typed error, or `undefined` when none
 * are present. Several shapes are supported: errors carrying `.status`
 * directly, axios/httpx-style errors nesting them under `.response`, and
 * errors that expose the status as a numeric `.code` (as the MCP SDK's
 * `StreamableHTTPError` does). A body is only read when it is already a
 * string, so no async `Response.text()` is ever invoked.
 */
function extractHttpDetails(err: unknown): string | undefined {
  if (!isRecord(err)) {
    return undefined;
  }
  const record = err;
  const responseValue = record['response'];
  const response = isRecord(responseValue) ? responseValue : undefined;
  const rawStatus = record['status'] ?? record['code'] ?? response?.['status'];
  const status =
    typeof rawStatus === 'number' &&
    rawStatus >= MIN_HTTP_STATUS &&
    rawStatus <= MAX_HTTP_STATUS
      ? rawStatus
      : undefined;
  const statusText = firstString(
    record['statusText'],
    response?.['statusText'],
  );
  const body = firstString(
    response?.['data'],
    response?.['body'],
    response?.['text'],
  );
  if (status === undefined && body === undefined) {
    return undefined;
  }
  const head =
    status === undefined
      ? 'HTTP error'
      : `HTTP ${status}${statusText === undefined ? '' : ` ${statusText}`}`;
  return body === undefined ? head : `${head}: ${truncateBody(body)}`;
}

/**
 * Recursively flattens aggregate and wrapped errors into a single message.
 * `seen` guards against cyclic `cause`/`errors` graphs.
 */
function formatErrorRecursive(err: unknown, seen: Set<unknown>): string {
  if (err === null || err === undefined) {
    return UNKNOWN_ERROR;
  }
  if (typeof err === 'object') {
    if (seen.has(err)) {
      return baseMessage(err);
    }
    seen.add(err);
  }
  if (err instanceof AggregateError && err.errors.length > 0) {
    return err.errors.map((sub) => formatErrorRecursive(sub, seen)).join(' | ');
  }
  const http = extractHttpDetails(err);
  const base = baseMessage(err);
  // Cycles (including a direct `err.cause === err`) are handled by `seen`.
  const cause = isRecord(err) ? err['cause'] : undefined;
  const causeMessage =
    cause !== undefined ? formatErrorRecursive(cause, seen) : undefined;
  let message = base.length > 0 ? base : UNKNOWN_ERROR;
  if (http !== undefined) {
    message = `${message} (${http})`;
  }
  if (
    causeMessage !== undefined &&
    http === undefined &&
    !message.includes(causeMessage)
  ) {
    message = `${message}: ${causeMessage}`;
  }
  return message;
}

/**
 * Formats an arbitrary thrown value into a readable, root-cause message.
 *
 * Recursively flattens `AggregateError.errors` (joining leaves with ` | `) and
 * unwraps the `Error.cause` chain, and — when HTTP details are synchronously
 * available — appends the status code and a response-body snippet truncated to
 * 1000 characters with a `... [truncated]` marker. It never throws and is safe
 * on `null`/`undefined` and cyclic error graphs.
 *
 * @param err The thrown or rejected value to format.
 * @return A single human-readable message describing the root cause(s).
 */
export function formatError(err: unknown): string {
  return formatErrorRecursive(err, new Set<unknown>());
}

/**
 * Recursively searches an error graph for a cancellation. `seen` guards
 * against cyclic `cause`/`errors` graphs.
 */
function hasCancellationName(err: unknown, seen: Set<unknown>): boolean {
  if (!isRecord(err) || seen.has(err)) {
    return false;
  }
  const record = err;
  seen.add(record);
  const name = record['name'];
  if (typeof name === 'string' && CANCELLATION_ERROR_NAMES.has(name)) {
    return true;
  }
  const errors = record['errors'];
  if (
    Array.isArray(errors) &&
    errors.some((sub) => hasCancellationName(sub, seen))
  ) {
    return true;
  }
  return hasCancellationName(record['cause'], seen);
}

/**
 * Reports whether `err`, or anything reachable through its `cause` chain or
 * its `AggregateError.errors`, is a cancellation.
 *
 * The whole graph is searched because a transport often translates a
 * cancellation into another error while it tears the connection down. The
 * match is on the error `name` rather than on the class, so an error built by
 * a second copy of a package still matches.
 *
 * Never throws, and is safe on `null`, `undefined`, primitives and cyclic
 * error graphs.
 *
 * @param err The thrown or rejected value to classify.
 * @return `true` when the value carries a cancellation.
 */
export function isAbortError(err: unknown): boolean {
  return hasCancellationName(err, new Set<unknown>());
}

/**
 * Returns the timeout name a single value carries, ignoring anything it wraps.
 * A value recognised by its code reports that code, because the name of such
 * an error is usually the bare `Error` and tells a reader nothing.
 */
function ownTimeoutName(record: Record<string, unknown>): string | undefined {
  const name = firstString(record['name']);
  if (name !== undefined && TIMEOUT_ERROR_NAMES.has(name)) {
    return name;
  }
  const code = firstString(record['code']);
  return code !== undefined && TIMEOUT_ERROR_CODES.has(code) ? code : undefined;
}

/**
 * Searches an error and everything it wraps for a timeout. `seen` guards
 * against cyclic `cause`/`errors` graphs.
 */
function findTimeoutName(err: unknown, seen: Set<unknown>): string | undefined {
  const record = asRecord(err);
  if (record === undefined || seen.has(err)) {
    return undefined;
  }
  seen.add(err);
  const own = ownTimeoutName(record);
  if (own !== undefined) {
    return own;
  }
  const nested =
    err instanceof AggregateError
      ? [...err.errors, record['cause']]
      : [record['cause']];
  for (const value of nested) {
    const found = findTimeoutName(value, seen);
    if (found !== undefined) {
      return found;
    }
  }
  return undefined;
}

/**
 * Returns the name of the timeout an arbitrary thrown value reports, or
 * `undefined` when it reports none.
 *
 * The `AggregateError.errors` list and the `Error.cause` chain are searched as
 * well, because Node's `fetch` rejects with a plain `TypeError: fetch failed`
 * that carries the real transport error as its cause. It never throws and is
 * safe on `null`/`undefined` and cyclic error graphs.
 *
 * @param err The thrown or rejected value to classify.
 * @return The timeout's name, or `undefined` when the value is not a timeout.
 */
export function timeoutErrorName(err: unknown): string | undefined {
  return findTimeoutName(err, new Set<unknown>());
}

/**
 * Whether a thrown value is Node's "no such file or directory" error.
 *
 * @param err The thrown or rejected value to inspect.
 * @return `true` when the value carries the `ENOENT` error code.
 */
export function isFileNotFoundError(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    err.code === 'ENOENT'
  );
}

/** gRPC `NOT_FOUND` status code. */
const GRPC_NOT_FOUND = 5;

/** HTTP `404 Not Found` status code. */
const HTTP_NOT_FOUND = 404;

/**
 * True when a thrown value reports the requested resource as missing.
 *
 * gRPC transports report NOT_FOUND as a numeric `code`; the `@google/genai`
 * `ApiClient` throws an `ApiError` carrying a numeric `status` instead. Matched
 * structurally, not with `instanceof`: `@google-cloud/vertexai` resolves its own
 * copy of `@google/genai`, so its `ApiError` is a different class object.
 *
 * @param error The thrown or rejected value to inspect.
 * @return True when the value carries a not-found status.
 */
export function isNotFoundError(error: unknown): boolean {
  const err = error as {code?: number; status?: number} | null | undefined;
  return (
    err?.code === GRPC_NOT_FOUND ||
    err?.code === HTTP_NOT_FOUND ||
    err?.status === HTTP_NOT_FOUND
  );
}

/** The canonical status and message a backend reported for a failed call. */
export interface ApiErrorDetails {
  /**
   * The canonical status, e.g. `RESOURCE_EXHAUSTED`. Falls back to the numeric
   * HTTP status as a string when the body carries no canonical name.
   */
  status: string;
  /** The backend's human-readable message. */
  message: string;
}

/**
 * Parses the JSON error body a `@google/genai` `ApiError` carries in its
 * message. The streaming path prefixes the body with `got status: <n>. `, so
 * parsing starts at the first brace.
 */
function parseErrorPayload(
  message: string,
): Record<string, unknown> | undefined {
  const start = message.indexOf('{');
  if (start < 0) {
    return undefined;
  }
  try {
    return asRecord(JSON.parse(message.slice(start)));
  } catch {
    return undefined;
  }
}

/**
 * Reads the canonical status and message out of a `@google/genai` `ApiError`,
 * or returns `undefined` when `error` is not one.
 *
 * Matched structurally on the numeric `status` plus a string `message` rather
 * than with `instanceof`: a runtime can resolve `@google/genai` twice, and an
 * `ApiError` built by one copy is not an instance of the other copy's class.
 *
 * The SDK reports `status` as the HTTP status code and puts the backend's JSON
 * error body in `message`, so the canonical status name (`RESOURCE_EXHAUSTED`)
 * and the human message are recovered from that body.
 *
 * @param error The thrown value to inspect.
 * @return The backend's status and message, or undefined for any other value.
 */
export function getApiErrorDetails(
  error: unknown,
): ApiErrorDetails | undefined {
  const record = asRecord(error);
  if (
    typeof record?.['status'] !== 'number' ||
    typeof record['message'] !== 'string'
  ) {
    return undefined;
  }
  const payload = asRecord(parseErrorPayload(record['message'])?.['error']);
  return {
    status: firstString(payload?.['status']) ?? String(record['status']),
    message: firstString(payload?.['message']) ?? record['message'],
  };
}
