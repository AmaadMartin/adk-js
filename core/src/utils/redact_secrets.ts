/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {AuthCredentialTypes} from '../auth/auth_credential.js';
import {State} from '../sessions/state.js';

/** Marker written in place of a value that holds a credential. */
export const REDACTED = '[REDACTED]';

/** Marker written when a value cannot be turned into a string at all. */
const UNSERIALIZABLE = '<unserializable>';

/**
 * Mapping keys whose value is a secret, for credentials that arrive as plain
 * objects rather than as typed values: session state rehydrated from a session
 * service, or the already serialized credential the OpenAPI tool auth handler
 * keeps in state.
 */
const SENSITIVE_KEYS: ReadonlySet<string> = new Set([
  'access_token',
  'api_key',
  'auth_code',
  'auth_response_uri',
  'authorization',
  'client_secret',
  'code_verifier',
  'google_access_id',
  'id_token',
  'password',
  'private_key',
  'private_key_id',
  'proxy_authorization',
  'refresh_token',
  'secret',
  'sig',
  'signature',
  'token',
  'x_amz_credential',
  'x_amz_signature',
  'x_api_key',
  'x_goog_credential',
  'x_goog_security_token',
  'x_goog_signature',
]);

/**
 * Substrings that name a secret wherever they sit in a key. Matched as
 * substrings, not whole keys, so that the spellings the exact set above cannot
 * enumerate are covered too: `openai_api_key`, `secret_key`,
 * `service_account_credentials`.
 */
const SENSITIVE_SUBSTRINGS = [
  'api_key',
  'credentials',
  'passwd',
  'password',
  'private_key',
  'secret',
] as const;

/**
 * A key ending in one of these names a secret: `bearer_token`,
 * `session_token`. Matched as a suffix rather than as a substring so that the
 * usage counters, `promptTokenCount` and its siblings, keep their values.
 */
const SENSITIVE_SUFFIXES = ['_token'] as const;

/**
 * Session state keys are namespaced by scope. The scope says nothing about
 * whether the value is a secret, so it is stripped before matching, otherwise
 * `api_key` is redacted while `user:api_key` is written out.
 */
const STATE_PREFIXES = [State.APP_PREFIX, State.USER_PREFIX] as const;

/**
 * Splits a camel-cased key so that `apiKey` and `XApiKey` normalize to the
 * same `api_key` that `api-key` and `api_key` do.
 */
const CAMEL_BOUNDARY = /(?<=[a-z0-9])(?=[A-Z])|(?<=[A-Z])(?=[A-Z][a-z])/g;

/**
 * A credential pasted into session state or a tool argument arrives as one
 * long string, and a service account file keeps its private key inside that
 * string, so no key name identifies it. Only an armored private key block is
 * looked for. It is unambiguous, where a general secret scan would be both
 * slow and prone to blanking ordinary text. The armor header is matched as a
 * unit so that prose quoting one of its fragments is left alone, and only the
 * block itself is replaced, so the rest of the string stays readable. A block
 * whose footer never arrives is redacted to the end of the string: `$` without
 * the `m` flag anchors at end-of-input, not end-of-line.
 */
const PRIVATE_KEY_BLOCK =
  /-----BEGIN [A-Z0-9 ]*PRIVATE KEY( BLOCK)?-----[\s\S]*?(-----END [A-Z0-9 ]*PRIVATE KEY( BLOCK)?-----|$)/g;

/**
 * Bounds the walk, which is otherwise unterminated on a self-referential
 * value. Deeper than any credential shape nests.
 */
const MAX_WALK_DEPTH = 20;

/** Every `authType` value an {@link AuthCredential} can carry. */
const AUTH_CREDENTIAL_TYPES: ReadonlySet<string> = new Set(
  Object.values(AuthCredentialTypes),
);

/** The complete field set of an `HttpCredentials`. */
const HTTP_CREDENTIAL_KEYS: ReadonlySet<string> = new Set([
  'username',
  'password',
  'token',
]);

/**
 * The `OAuth2Auth` fields that carry a secret. A bare `{clientId}` is not one
 * of them: it holds nothing to protect.
 */
const OAUTH2_SECRET_KEYS = [
  'clientSecret',
  'accessToken',
  'refreshToken',
  'idToken',
  'authCode',
  'codeVerifier',
  'authResponseUri',
] as const;

/**
 * How many of {@link HTTP_CREDENTIAL_KEYS} a value must carry before its shape
 * identifies it as an `HttpCredentials`. A single `{token: ...}` is any
 * caller's object, and collapsing it wholesale would hide the rest of a debug
 * payload; its key name redacts the value on its own.
 */
const MIN_HTTP_CREDENTIAL_KEYS = 2;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Whether a value's own prototype is `Object.prototype` or none, i.e. it is a
 * mapping rather than an instance of some class with behaviour of its own.
 */
function isPlainObject(value: object): boolean {
  const prototype = Object.getPrototypeOf(value);
  return prototype === null || prototype === Object.prototype;
}

/**
 * Realm-safe tag check. `instanceof` reports false for a value built by
 * another copy of a package in the same runtime, which is a configuration
 * adk-js supports.
 */
function hasTag(value: unknown, tag: string): boolean {
  return Object.prototype.toString.call(value) === `[object ${tag}]`;
}

function isDate(value: unknown): value is Date {
  return hasTag(value, 'Date');
}

function isMap(value: unknown): value is Map<unknown, unknown> {
  return hasTag(value, 'Map');
}

function isSet(value: unknown): value is Set<unknown> {
  return hasTag(value, 'Set');
}

function isAuthCredential(value: Record<string, unknown>): boolean {
  const authType = value['authType'];
  return typeof authType === 'string' && AUTH_CREDENTIAL_TYPES.has(authType);
}

function isServiceAccountCredential(value: Record<string, unknown>): boolean {
  return value['type'] === 'service_account';
}

function isServiceAccount(value: Record<string, unknown>): boolean {
  if ('serviceAccountCredential' in value) {
    return true;
  }
  return (
    'scopes' in value &&
    ('useDefaultCredential' in value || 'useIdToken' in value)
  );
}

function isHttpAuth(value: Record<string, unknown>): boolean {
  return typeof value['scheme'] === 'string' && isRecord(value['credentials']);
}

function isHttpCredentials(value: Record<string, unknown>): boolean {
  const keys = Object.keys(value);
  return (
    keys.length >= MIN_HTTP_CREDENTIAL_KEYS &&
    keys.every((key) => HTTP_CREDENTIAL_KEYS.has(key))
  );
}

function isOAuth2Auth(value: Record<string, unknown>): boolean {
  return OAUTH2_SECRET_KEYS.some((key) => key in value);
}

/**
 * Whether a mapping key names a credential-bearing value.
 *
 * The key is folded first, so that `apiKey`, `X-Api-Key`, `api_key` and
 * `user:api_key` all match the same rule.
 */
export function isSensitiveKey(key: string): boolean {
  let normalized = key
    .replace(CAMEL_BOUNDARY, '_')
    .toLowerCase()
    .replaceAll('-', '_');
  // ADK stores exchanged auth credentials under a `temp:`-prefixed state key.
  if (normalized.startsWith(State.TEMP_PREFIX)) {
    return true;
  }
  for (const prefix of STATE_PREFIXES) {
    if (normalized.startsWith(prefix)) {
      normalized = normalized.slice(prefix.length);
      break;
    }
  }
  if (SENSITIVE_KEYS.has(normalized)) {
    return true;
  }
  if (SENSITIVE_SUFFIXES.some((suffix) => normalized.endsWith(suffix))) {
    return true;
  }
  return SENSITIVE_SUBSTRINGS.some((marker) => normalized.includes(marker));
}

/** Blanks any armored private key block, leaving the rest of the string. */
export function redactPrivateKeyBlocks(value: string): string {
  // A string replacement expands `$&` and friends. `REDACTED` is a literal
  // holding no `$`, so it is substituted as written.
  return value.replace(PRIVATE_KEY_BLOCK, REDACTED);
}

/**
 * Whether a value's shape identifies it as one of the ADK credential types,
 * in which case it is replaced wholesale rather than walked field by field.
 *
 * The credential types are erased interfaces with no runtime representation,
 * so this matches on structure. It is also what the repository requires of a
 * type check: `instanceof` reports false when two copies of a package share a
 * runtime.
 */
export function isCredentialLike(value: unknown): boolean {
  if (!isRecord(value)) {
    return false;
  }
  return (
    isAuthCredential(value) ||
    isServiceAccountCredential(value) ||
    isServiceAccount(value) ||
    isHttpAuth(value) ||
    isHttpCredentials(value) ||
    isOAuth2Auth(value)
  );
}

function stringify(value: unknown): string {
  try {
    return String(value);
  } catch {
    return UNSERIALIZABLE;
  }
}

/** The type name reported when the walk stops at {@link MAX_WALK_DEPTH}. */
function typeLabel(value: unknown): string {
  if (Array.isArray(value)) {
    return 'Array';
  }
  const constructorName = Object.getPrototypeOf(value)?.constructor?.name;
  return typeof constructorName === 'string' ? constructorName : 'Object';
}

function serializeEntries(
  entries: Iterable<readonly [unknown, unknown]>,
  depth: number,
): Record<string, unknown> {
  const serialized: Record<string, unknown> = {};
  for (const [key, value] of entries) {
    const name = stringify(key);
    serialized[name] = isSensitiveKey(name)
      ? REDACTED
      : safeSerialize(value, depth);
  }
  return serialized;
}

/**
 * Produces a redacted, YAML-safe copy of an arbitrary value.
 *
 * A credential is replaced with {@link REDACTED} wherever it sits, under any
 * key name and at any depth. A mapping key that names a secret is redacted
 * too, for a credential that arrives already flattened to a plain object. An
 * armored private key block, which no key name identifies, is cut out of
 * whatever string it sits in.
 *
 * @param value The value to copy.
 * @param depth How deep into the walk this value sits. Callers pass nothing.
 * @returns A value made only of plain objects, arrays, strings, numbers,
 *     booleans and `null`.
 */
export function safeSerialize(value: unknown, depth = 0): unknown {
  if (value === null || value === undefined) {
    return null;
  }
  // Checked before the depth bound, so that a deeply nested credential is
  // redacted rather than merely labelled.
  if (isCredentialLike(value)) {
    return REDACTED;
  }
  if (depth > MAX_WALK_DEPTH) {
    // Terminates a self-referential value. Only the type name survives, so
    // reaching the bound cannot uncover a value.
    return `<${typeLabel(value)} ...>`;
  }
  const childDepth = depth + 1;
  if (typeof value === 'string') {
    return redactPrivateKeyBlocks(value);
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'bigint') {
    return String(value);
  }
  if (Array.isArray(value)) {
    return value.map((item) => safeSerialize(item, childDepth));
  }
  if (isDate(value)) {
    return value.toISOString();
  }
  if (ArrayBuffer.isView(value)) {
    return `<bytes: ${value.byteLength} bytes>`;
  }
  if (isSet(value)) {
    return [...value].map((item) => safeSerialize(item, childDepth));
  }
  if (isMap(value)) {
    return serializeEntries(value, childDepth);
  }
  if (isRecord(value) && isPlainObject(value)) {
    return serializeEntries(Object.entries(value), childDepth);
  }
  return stringify(value);
}

/**
 * Produces a redacted, YAML-safe copy of a mapping.
 *
 * Equivalent to {@link safeSerialize} on the same mapping, with the result
 * already narrowed to a record.
 */
export function safeSerializeRecord(
  value: Record<string, unknown>,
): Record<string, unknown> {
  return serializeEntries(Object.entries(value), 1);
}
