/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The JSON boundary of the eval data model.
 *
 * Eval sets are written by adk-python as well as by this package, so the field
 * names on disk are snake_case and stay that way. The in-memory interfaces use
 * camelCase, like the rest of adk-js, and these functions convert between the
 * two.
 *
 * Values that hold user data rather than model fields — tool call arguments,
 * tool responses and session state — are copied verbatim, because renaming
 * their keys would corrupt them.
 */

import {Content, FunctionCall, FunctionResponse, Part} from '@google/genai';
import {
  EvalCase,
  IntermediateDataType,
  Invocation,
  InvocationEvent,
  SessionInput,
} from './eval_case.js';
import {EvalSet} from './eval_set.js';

/**
 * Keys whose values are opaque user data. Their contents keep the exact keys
 * they were written with, in both directions.
 */
const OPAQUE_KEYS: ReadonlySet<string> = new Set([
  'args',
  'response',
  'state',
  'final_session_state',
  'finalSessionState',
]);

/** Narrows an unknown value to a plain (non-array) record. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Raised when a file does not hold an eval set in the current schema. */
export class EvalSetSchemaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EvalSetSchemaError';
  }
}

/** Recursively rewrites snake_case keys to camelCase, skipping opaque values. */
export function toCamelKeys(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(toCamelKeys);
  }
  if (!isRecord(value)) {
    return value;
  }
  const converted: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    const camelKey = key.replace(/_([a-z])/g, (_, letter: string) =>
      letter.toUpperCase(),
    );
    converted[camelKey] = OPAQUE_KEYS.has(key) ? entry : toCamelKeys(entry);
  }
  return converted;
}

/** Recursively rewrites camelCase keys to snake_case, skipping opaque values. */
export function toSnakeKeys(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(toSnakeKeys);
  }
  if (!isRecord(value)) {
    return value;
  }
  const converted: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    const snakeKey = key.replace(
      /[A-Z]/g,
      (letter) => `_${letter.toLowerCase()}`,
    );
    converted[snakeKey] = OPAQUE_KEYS.has(key) ? entry : toSnakeKeys(entry);
  }
  return converted;
}

/**
 * Converts a JSON value to an {@link EvalSet}.
 *
 * Only the fields the interfaces declare are carried across; a field written
 * by a newer adk-python is dropped rather than passed through untyped.
 *
 * @throws {EvalSetSchemaError} If the value is not an eval set in the current
 *   schema. Callers use that to fall back to the legacy format, so it is
 *   deliberately distinct from a JSON parse failure.
 */
export function parseEvalSet(raw: unknown): EvalSet {
  const converted = toCamelKeys(raw);
  if (!isRecord(converted)) {
    throw new EvalSetSchemaError('An eval set must be a JSON object.');
  }
  const evalSetId = converted['evalSetId'];
  const evalCases = converted['evalCases'];
  if (typeof evalSetId !== 'string') {
    throw new EvalSetSchemaError('An eval set must have an `eval_set_id`.');
  }
  if (!Array.isArray(evalCases)) {
    throw new EvalSetSchemaError('An eval set must have `eval_cases`.');
  }
  return {
    evalSetId,
    name: optionalString(converted['name']),
    description: optionalString(converted['description']),
    evalCases: evalCases.map(parseEvalCase),
    creationTimestamp: numberOrZero(converted['creationTimestamp']),
  };
}

function parseEvalCase(raw: unknown): EvalCase {
  if (!isRecord(raw) || typeof raw['evalId'] !== 'string') {
    throw new EvalSetSchemaError('Every eval case must have an `eval_id`.');
  }
  const conversation = raw['conversation'];
  return {
    evalId: raw['evalId'],
    conversation: Array.isArray(conversation)
      ? conversation.map(parseInvocation)
      : undefined,
    sessionInput: parseSessionInput(raw['sessionInput']),
    creationTimestamp: numberOrZero(raw['creationTimestamp']),
    finalSessionState: isRecord(raw['finalSessionState'])
      ? raw['finalSessionState']
      : undefined,
  };
}

function parseSessionInput(raw: unknown): SessionInput | undefined {
  if (!isRecord(raw)) {
    return undefined;
  }
  return {
    appName: stringOrEmpty(raw['appName']),
    userId: stringOrEmpty(raw['userId']),
    sessionId: optionalString(raw['sessionId']),
    state: isRecord(raw['state']) ? raw['state'] : {},
  };
}

function parseInvocation(raw: unknown): Invocation {
  if (!isRecord(raw)) {
    throw new EvalSetSchemaError('Every invocation must be a JSON object.');
  }
  const userContent = asContent(raw['userContent']);
  if (!userContent) {
    throw new EvalSetSchemaError(
      'Every invocation must have a `user_content`.',
    );
  }
  return {
    invocationId: stringOrEmpty(raw['invocationId']),
    userContent,
    finalResponse: asContent(raw['finalResponse']),
    intermediateData: asIntermediateData(raw['intermediateData']),
    creationTimestamp: numberOrZero(raw['creationTimestamp']),
  };
}

/**
 * Accepts a record as `Content`. The genai types are all-optional bags of
 * fields, so this checks that the value is an object and trusts the writer for
 * the rest, exactly as an unvalidated `JSON.parse` result would be trusted.
 */
function asContent(value: unknown): Content | undefined {
  return isRecord(value) ? (value as Content) : undefined;
}

function asIntermediateData(value: unknown): IntermediateDataType | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const events = value['invocationEvents'];
  if (Array.isArray(events)) {
    return {invocationEvents: events.map(parseInvocationEvent)};
  }
  return {
    toolUses: asArray<FunctionCall>(value['toolUses']),
    toolResponses: asArray<FunctionResponse>(value['toolResponses']),
    intermediateResponses: asArray<[string, Part[]]>(
      value['intermediateResponses'],
    ),
  };
}

function parseInvocationEvent(raw: unknown): InvocationEvent {
  if (!isRecord(raw)) {
    throw new EvalSetSchemaError('Every invocation event must be an object.');
  }
  return {
    author: stringOrEmpty(raw['author']),
    content: asContent(raw['content']),
  };
}

/**
 * Accepts a JSON array as a list of `T`, mirroring {@link asContent}: the
 * element types are genai payloads whose fields this module never reads.
 */
function asArray<T>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : [];
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function stringOrEmpty(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function numberOrZero(value: unknown): number {
  return typeof value === 'number' ? value : 0;
}

/** Serializes an eval set to its on-disk JSON form, with snake_case keys. */
export function serializeEvalSet(evalSet: EvalSet): string {
  return JSON.stringify(toSnakeKeys(evalSet), undefined, 2);
}
