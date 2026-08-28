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

import {toSnakeCaseName} from './case_utils.js';

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
 * Replaces a string that is shaped like JSON but cannot be verified free of
 * credentials. Such a string is dropped whole: a substring search over raw text
 * is bypassable through `\u005f`-style escapes, so text that does not parse
 * cannot be cleared.
 */
const UNPARSEABLE_JSON_BLOB = '[UNPARSEABLE_JSON_BLOB]';

/**
 * Longest string this module parses as JSON. A longer one is replaced instead,
 * which bounds the work a single adversarial payload can cause.
 */
const MAX_INSPECT_CHARS = 4_000_000;

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
 * {@link toSnakeCaseName} brings `X-Api-Key`, `apiKey` and `x_api_key` to the
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
 * Returns whether `key` names a credential and must have its value replaced.
 *
 * The name is folded to snake_case first. adk-python only folds case and `-`,
 * because a Python payload spells these keys `access_token`. A JavaScript
 * payload spells the same key `accessToken`, so camel humps are split too.
 * That only widens redaction, and a key nobody meant to protect keeps its
 * value because it is still absent from the set.
 *
 * @param key The property name to classify.
 * @return True when the value under `key` must be redacted.
 */
function isSensitiveKey(key: string): boolean {
  const normalized = toSnakeCaseName(key);
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

/** A whole HTTP header line that carries a credential. */
const CREDENTIAL_HEADER_PATTERN =
  /^([ \t]*(?:authorization|proxy-authorization|x-api-key|api-key)[ \t]*:)[^\r\n]*/gim;

/**
 * An `Authorization` value, wherever it appears without its header name. The
 * scheme name goes with the token, so an inline `Authorization: Bearer x`
 * leaves one marker: the key-value pass below skips a value that already opens
 * a bracket.
 */
const BEARER_PATTERN = /\bbearer[ \t]+[^\s,;"']+/gi;

/**
 * A URL query parameter named `key`. `key` is too common a word to redact by
 * name everywhere, but in this position it is how Google APIs carry an API key,
 * and a failing request echoes its own URL.
 */
const QUERY_KEY_PATTERN = /([?&]key=)[^\s&#"']+/gi;

/**
 * A `name: value` or `name=value` fragment. The name is classified by
 * {@link isSensitiveKey}, so free text and structured payloads redact the same
 * set of names. The value must be non-empty and must not open a bracket, which
 * keeps the pass idempotent over text that already reads `token: [REDACTED]`.
 *
 * The leading lookbehind rejects a name that starts mid-word. Without it, one
 * unbroken run of name characters costs a greedy scan per character, which is
 * quadratic: 16,000 characters take 1.3 seconds, so a payload at the default
 * length limit blocks the event loop for minutes.
 */
const KEY_VALUE_PATTERN =
  /(?<![A-Za-z0-9_.:-])(["']?)([A-Za-z_][A-Za-z0-9_.:-]*)\1(\s*[:=]\s*)(["']?)([^\s,;&)}\]["']+)\4/g;

/**
 * Replaces the credentials in `text`, leaving every other character in place.
 *
 * Each pass uses a replacement function rather than a replacement string: `$&`
 * and `$1` are expanded inside a replacement string, so text the model or a
 * tool supplied would otherwise be rewritten.
 *
 * @param text The free text to redact.
 * @return The text with every recognized credential replaced.
 */
function redactFreeText(text: string): string {
  return redactKeyValuePairs(
    text
      .replace(CREDENTIAL_HEADER_PATTERN, (_match, header: string) => {
        return `${header} ${REDACTED}`;
      })
      .replace(BEARER_PATTERN, () => REDACTED)
      .replace(QUERY_KEY_PATTERN, (_match, prefix: string) => {
        return `${prefix}${REDACTED}`;
      }),
  );
}

/**
 * Replaces the value of every sensitive `name: value` pair in `text`.
 *
 * A value may itself contain a separator, so a pair under a harmless name can
 * span a sensitive one: `connection failed: password=hunter2` matches as the
 * name `failed` over the value `password=hunter2`. `String.replace` would
 * resume after that value and never see the password. Scanning by hand instead
 * lets a skipped name resume at the character after the name, so every pair the
 * text contains is classified. Each step moves forward by at least one
 * character, so the scan stays linear.
 *
 * @param text The free text to redact.
 * @return The text with every sensitive value replaced.
 */
function redactKeyValuePairs(text: string): string {
  KEY_VALUE_PATTERN.lastIndex = 0;
  let result = '';
  let copiedTo = 0;
  let match: RegExpExecArray | null;
  while ((match = KEY_VALUE_PATTERN.exec(text)) !== null) {
    const [whole, keyQuote, key, separator, valueQuote] = match;
    if (!isSensitiveKey(key)) {
      KEY_VALUE_PATTERN.lastIndex = match.index + keyQuote.length + key.length;
      continue;
    }
    result += text.slice(copiedTo, match.index);
    result += `${keyQuote}${key}${keyQuote}${separator}${valueQuote}${REDACTED}${valueQuote}`;
    copiedTo = match.index + whole.length;
  }
  return result + text.slice(copiedTo);
}

/**
 * Returns `text` with its credentials replaced and its length bounded.
 *
 * This is the pass for text that has no structure the caller can walk: an
 * error message, a stack trace, a log line. Redaction is pattern-based, so it
 * catches an `Authorization` header, a bearer token, an API key in a URL, and a
 * `name=value` pair whose name is a credential. Ordinary prose comes back
 * unchanged.
 *
 * Redaction runs before truncation, so a credential the length limit would
 * have cut in half is already gone. Only {@link MAX_INSPECT_CHARS} characters
 * are inspected, which bounds the work regardless of the caller's limit.
 *
 * @param text The free text to sanitize.
 * @param maxLength Maximum length of the result, or -1 for no limit.
 * @return The sanitized text and whether anything was cut.
 */
export function sanitizeErrorText(
  text: string,
  maxLength: number,
): {text: string; truncated: boolean} {
  const inspected = text.slice(0, MAX_INSPECT_CHARS);
  const bounded = truncateText(redactFreeText(inspected), maxLength);
  return {
    text: bounded.text,
    truncated: bounded.truncated || inspected.length < text.length,
  };
}

/** Whether `text` is shaped like a JSON object or array. */
function isJsonShaped(text: string): boolean {
  const start = text.trimStart();
  return start.startsWith('{') || start.startsWith('[');
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

/**
 * Sanitizes a string leaf.
 *
 * A credential often arrives as an opaque JSON string — a tool result, a
 * serialized request body — where walking the enclosing object cannot see it.
 * Such a string is parsed, walked like any other structure, and re-serialized.
 * Re-serialization is unconditional because `JSON.parse` keeps the last of a
 * duplicate key: a blob carrying the secret under an earlier copy of the key
 * would otherwise pass through as its own raw text.
 *
 * A string that is shaped like JSON but does not parse is replaced whole. It
 * cannot be shown to be free of credentials, and searching its raw text is
 * bypassable. Everything else goes through the free-text pass.
 */
function sanitizeStringLeaf(
  text: string,
  state: SanitizeState,
  depth: number,
): SanitizeResult {
  if (!isJsonShaped(text)) {
    const sanitized = sanitizeErrorText(text, state.maxLength);
    return {value: sanitized.text, truncated: sanitized.truncated};
  }
  if (text.length > MAX_INSPECT_CHARS) {
    return {value: UNPARSEABLE_JSON_BLOB, truncated: true};
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return {value: UNPARSEABLE_JSON_BLOB, truncated: true};
  }
  const walked = sanitizeValue(parsed, state, depth + 1);
  const bounded = truncateText(JSON.stringify(walked.value), state.maxLength);
  return {
    value: bounded.text,
    truncated: bounded.truncated || walked.truncated,
  };
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
    return sanitizeStringLeaf(String(value), state, depth);
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
