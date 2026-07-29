/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Content} from '@google/genai';

const DEFAULT_USER_ID = 'default-user';
const DEFAULT_SESSION_ID = 'default-session';

/**
 * A normalised `POST /api/reasoning_engine` query. Callers may send the fields
 * at the top level of the body or nested under `input`; `input` wins.
 */
export interface ReasoningEngineQuery {
  appName?: string;
  userId: string;
  sessionId: string;
  newMessage?: Content;
  stateDelta?: Record<string, unknown>;
}

/**
 * Narrows an untrusted request body into a {@link ReasoningEngineQuery}.
 *
 * The body is whatever the client sent, so every field is validated: values of
 * the wrong shape are reported as missing rather than passed on. Never throws.
 */
export function parseReasoningEngineQuery(
  rawBody: unknown,
): ReasoningEngineQuery {
  const body = isRecord(rawBody) ? rawBody : {};
  const input = isRecord(body['input']) ? body['input'] : {};

  const newMessage = input['newMessage'] || body['newMessage'];
  const stateDelta = input['stateDelta'] || body['stateDelta'];

  return {
    appName: readString(input, 'appName') ?? readString(body, 'appName'),
    userId:
      readString(input, 'userId') ??
      readString(body, 'userId') ??
      DEFAULT_USER_ID,
    sessionId:
      readString(input, 'sessionId') ??
      readString(body, 'sessionId') ??
      DEFAULT_SESSION_ID,
    newMessage: isContent(newMessage) ? newMessage : undefined,
    stateDelta: isRecord(stateDelta) ? stateDelta : undefined,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isContent(value: unknown): value is Content {
  if (!isRecord(value)) {
    return false;
  }
  const {parts, role} = value;
  return (
    (parts === undefined || (Array.isArray(parts) && parts.every(isRecord))) &&
    (role === undefined || typeof role === 'string')
  );
}

/** Reads a non-empty string, so that `''` falls back to the next candidate. */
function readString(
  source: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = source[key];
  return typeof value === 'string' && value !== '' ? value : undefined;
}
