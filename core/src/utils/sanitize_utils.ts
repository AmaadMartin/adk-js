/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Bounded sanitizer for arbitrary values that are about to be persisted or
 * logged.
 *
 * Telemetry payloads come from models, tools and user content, so they are
 * unbounded in size, may contain credentials, and may contain reference
 * cycles. This module walks such a value once and returns a copy that is safe
 * to serialize: long strings are truncated, credential-bearing keys are
 * replaced, and the walk itself is capped in depth and in total nodes visited.
 *
 * Every replacement uses a fixed sentinel string so that a downstream consumer
 * can tell why a value is missing.
 */

/** Appended to a string that was cut down to the caller's length limit. */
const TRUNCATED_SUFFIX = '...[TRUNCATED]';

/** Replaces a value that points back to one of its own ancestors. */
const CIRCULAR_REFERENCE = '[CIRCULAR_REFERENCE]';

/** Replaces a value nested deeper than `MAX_SANITIZE_DEPTH`. */
const MAX_DEPTH_EXCEEDED = '[MAX_DEPTH_EXCEEDED]';

/** Replaces the remainder of a value once the node budget runs out. */
const SANITIZE_BUDGET_EXCEEDED = '[SANITIZE_BUDGET_EXCEEDED]';

/** Replaces the value of a credential-bearing key. */
const REDACTED = '[REDACTED]';

/**
 * Recursion bound. A value nested deeper than this is replaced, which turns an
 * adversarially nested payload into a redacted leaf instead of a stack
 * overflow.
 */
const MAX_SANITIZE_DEPTH = 50;

/**
 * Total values one {@link recursiveSmartTruncate} call may visit. Depth and
 * per-string length are bounded on their own, but width is not: a
 * million-element array otherwise burns unbounded synchronous time.
 */
const MAX_SANITIZE_NODES = 100_000;

/**
 * Keys whose values are credentials, written in snake_case.
 * {@link normalizeKey} brings `X-Api-Key`, `apiKey` and `x_api_key` to the
 * same form, so one entry covers every spelling a payload might use.
 */
const SENSITIVE_KEYS: ReadonlySet<string> = new Set([
  'client_secret',
  'access_token',
  'refresh_token',
  'id_token',
  'api_key',
  'password',
  'private_key',
  'proxy_authorization',
  'google_access_id',
  'sig',
  'signature',
  'token',
  'secret',
  'authorization',
  'x_api_key',
  'x_amz_credential',
  'x_amz_signature',
  'x_goog_credential',
  'x_goog_security_token',
  'x_goog_signature',
]);

/**
 * Prefix marking a temporary, invocation-scoped state key. Such keys carry
 * short-lived credentials often enough that the whole namespace is redacted.
 */
const TEMP_KEY_PREFIX = 'temp:';

/** The outcome of one sanitizer pass. */
export interface SanitizeResult {
  /** The sanitized copy, safe to `JSON.stringify`. */
  value: unknown;
  /**
   * Whether any payload was lost. Redaction and cycle replacement do not set
   * this: they replace a credential or a back-reference, not data.
   */
  truncated: boolean;
}

/** Mutable bookkeeping shared by one sanitizer pass. */
interface SanitizeState {
  maxLength: number;
  budget: number;
  ancestors: Set<object>;
}

/**
 * Brings a property name to the snake_case form {@link SENSITIVE_KEYS} uses.
 *
 * adk-python only folds case and `-`, because Python payloads spell these keys
 * `access_token`. A JavaScript payload spells the same key `accessToken`, so
 * camel humps are split too. That only widens redaction, and a key nobody
 * meant to protect keeps its value because it is still absent from the set.
 */
function normalizeKey(key: string): string {
  return key
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .toLowerCase()
    .replaceAll('-', '_');
}

/**
 * Returns whether `key` names a credential and must have its value replaced.
 *
 * @param key The property name to classify.
 * @return True when the value under `key` must be redacted.
 */
function isSensitiveKey(key: string): boolean {
  const normalized = normalizeKey(key);
  return (
    SENSITIVE_KEYS.has(normalized) || normalized.startsWith(TEMP_KEY_PREFIX)
  );
}

/**
 * Cuts `text` down to `maxLength`, or leaves it whole when `maxLength` is -1.
 *
 * @param text The text to bound.
 * @param maxLength Maximum length, or -1 for no limit.
 * @return The bounded text and whether anything was cut.
 */
export function truncateText(
  text: string,
  maxLength: number,
): {text: string; truncated: boolean} {
  if (maxLength === -1 || text.length <= maxLength) {
    return {text, truncated: false};
  }
  return {text: text.slice(0, maxLength) + TRUNCATED_SUFFIX, truncated: true};
}

/** Sanitizes each element of `values`, stopping when the node budget runs out. */
function sanitizeArray(
  values: readonly unknown[],
  state: SanitizeState,
  depth: number,
): SanitizeResult {
  const result: unknown[] = [];
  let truncated = false;
  for (const element of values) {
    if (state.budget <= 0) {
      result.push(SANITIZE_BUDGET_EXCEEDED);
      truncated = true;
      break;
    }
    const sanitized = sanitizeValue(element, state, depth + 1);
    truncated = truncated || sanitized.truncated;
    result.push(sanitized.value);
  }
  return {value: result, truncated};
}

/**
 * Sanitizes the own enumerable properties of `record`, redacting
 * credential-bearing keys and stopping when the node budget runs out.
 */
function sanitizeRecord(
  record: object,
  state: SanitizeState,
  depth: number,
): SanitizeResult {
  const result: Record<string, unknown> = {};
  let truncated = false;
  for (const [key, element] of Object.entries(record)) {
    if (state.budget <= 0) {
      result[SANITIZE_BUDGET_EXCEEDED] = SANITIZE_BUDGET_EXCEEDED;
      truncated = true;
      break;
    }
    if (isSensitiveKey(key)) {
      state.budget -= 1;
      result[key] = REDACTED;
      continue;
    }
    const sanitized = sanitizeValue(element, state, depth + 1);
    truncated = truncated || sanitized.truncated;
    result[key] = sanitized.value;
  }
  return {value: result, truncated};
}

/** Sanitizes one value, dispatching on its shape. */
function sanitizeValue(
  value: unknown,
  state: SanitizeState,
  depth: number,
): SanitizeResult {
  state.budget -= 1;
  if (state.budget <= 0) {
    return {value: SANITIZE_BUDGET_EXCEEDED, truncated: true};
  }
  if (depth >= MAX_SANITIZE_DEPTH) {
    return {value: MAX_DEPTH_EXCEEDED, truncated: true};
  }
  if (
    value === null ||
    value === undefined ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  ) {
    return {value, truncated: false};
  }
  if (typeof value !== 'object') {
    // A string passes through `String` unchanged; a bigint, symbol or function
    // becomes text, so the result stays JSON-serializable either way.
    const {text, truncated} = truncateText(String(value), state.maxLength);
    return {value: text, truncated};
  }
  if (state.ancestors.has(value)) {
    return {value: CIRCULAR_REFERENCE, truncated: false};
  }
  state.ancestors.add(value);
  const result = sanitizeObject(value, state, depth);
  state.ancestors.delete(value);
  return result;
}

/**
 * Sanitizes an object, an array, or anything carrying a `toJSON` method. The
 * `toJSON` branch mirrors `JSON.stringify`, so a `Date` and any SDK type that
 * defines one survive as the value they serialize to instead of as `{}`.
 */
function sanitizeObject(
  value: object,
  state: SanitizeState,
  depth: number,
): SanitizeResult {
  if (Array.isArray(value)) {
    return sanitizeArray(value, state, depth);
  }
  const toJson = (value as {toJSON?: unknown}).toJSON;
  if (typeof toJson === 'function') {
    return sanitizeValue(
      (value as {toJSON(): unknown}).toJSON(),
      state,
      depth + 1,
    );
  }
  return sanitizeRecord(value, state, depth);
}

/**
 * Returns a bounded, credential-free copy of `value`.
 *
 * The walk truncates every string to `maxLength`, replaces the value of every
 * credential-bearing key with `[REDACTED]`, replaces a reference back to an
 * ancestor with `[CIRCULAR_REFERENCE]`, and stops with a sentinel once it
 * passes the depth cap of 50 levels or the budget of 100,000 values.
 *
 * A getter on `value` that throws propagates to the caller: the caller decides
 * whether an unreadable payload is fatal or is replaced by its own sentinel.
 *
 * @param value The value to sanitize.
 * @param maxLength Maximum length of any single string, or -1 for no limit.
 * @return The sanitized copy and whether any payload was lost.
 */
export function recursiveSmartTruncate(
  value: unknown,
  maxLength: number,
): SanitizeResult {
  return sanitizeValue(
    value,
    {maxLength, budget: MAX_SANITIZE_NODES, ancestors: new Set<object>()},
    0,
  );
}
