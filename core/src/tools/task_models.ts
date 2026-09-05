/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Schema, Type} from '@google/genai';
import {z} from 'zod';
import {InputValidationError} from '../errors/input_validation_error.js';
import {logger} from '../utils/logger.js';

/**
 * Reports whether a value is a non-null, non-array object.
 *
 * @param value The value to inspect.
 * @returns True if the value can carry string keys.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Renames the top-level `agent_name` key to `agentName`, so the spelling
 * adk-python's `model_dump()` writes validates here.
 *
 * The rename is deliberately not recursive. `input` holds an arbitrary user
 * payload whose own keys must survive untouched, and adk-python renames model
 * fields only. A payload that writes both spellings keeps them both: the rename
 * would drop one of the two values in silence, so the raw keys go through
 * instead and {@link taskRequestSchema} reports `agent_name` as an unknown key.
 *
 * @param raw The value about to be validated.
 * @returns The value with at most one key renamed.
 */
function normalizeAgentNameKey(raw: unknown): unknown {
  if (isRecord(raw) && 'agent_name' in raw && !('agentName' in raw)) {
    const {agent_name: agentName, ...rest} = raw;
    return {...rest, agentName};
  }
  return raw;
}

/** A request to delegate a task to a sub-agent. */
export interface TaskRequest {
  /** The name of the target agent to delegate to. */
  readonly agentName: string;
  /** The validated input data for the task. */
  readonly input: Record<string, unknown>;
}

/** The result returned by a task agent upon completion. */
export interface TaskResult {
  /** The validated output data from the task. */
  readonly output: unknown;
}

const taskRequestSchema = z.preprocess(
  normalizeAgentNameKey,
  z.strictObject({
    agentName: z.string({error: 'agentName must be a string.'}),
    input: z.record(z.string(), z.unknown(), {
      error: 'input must be an object.',
    }),
  }),
);

const taskResultSchema = z.strictObject({
  output: z.unknown().nonoptional('output is required.'),
});

/**
 * Validates a value against a schema and freezes the result.
 *
 * @param schema The schema to validate against.
 * @param value The value to validate.
 * @returns A frozen payload. A later write to it throws a `TypeError`.
 * @throws InputValidationError Carrying the first issue the schema reports.
 */
function parseOrThrow<T extends object>(
  schema: z.ZodType<T>,
  value: unknown,
): Readonly<T> {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw new InputValidationError(parsed.error.issues[0].message);
  }
  return Object.freeze(parsed.data);
}

/**
 * Validates a task delegation payload that arrives as `unknown`.
 *
 * A persisted payload can be written by either SDK, so `agent_name` is accepted
 * alongside `agentName`. The keys inside `input` are never rewritten.
 *
 * @param value The value to validate.
 * @returns A frozen request.
 * @throws InputValidationError If the value is not a valid task request.
 */
export function parseTaskRequest(value: unknown): TaskRequest {
  return parseOrThrow(taskRequestSchema, value);
}

/**
 * Validates a task completion payload that arrives as `unknown`.
 *
 * `output` is required but nullable, matching `Any` in the reference: the key
 * must be present, and its value may be anything including `null`.
 *
 * @param value The value to validate.
 * @returns A frozen result.
 * @throws InputValidationError If the value is not a valid task result.
 */
export function parseTaskResult(value: unknown): TaskResult {
  return parseOrThrow(taskResultSchema, value);
}

/**
 * Converts a value read back from a session into a {@link TaskRequest}.
 *
 * The reference short-circuits on `isinstance(value, TaskRequest)` and returns
 * the same instance. `TaskRequest` is a structural interface here, with no
 * class to test against, so every value goes through validation instead.
 * Validation is idempotent, so a value that is already a valid request comes
 * back equal to itself.
 *
 * @param value The value to convert.
 * @returns A frozen request.
 * @throws InputValidationError If the value is not a valid task request.
 */
export function asTaskRequest(value: unknown): TaskRequest {
  if (!isRecord(value)) {
    const typeName =
      value === null ? 'null' : Array.isArray(value) ? 'Array' : typeof value;
    logger.error(
      `Unexpected type for TaskRequest: ${typeName}. Expected an object.`,
    );
  }
  return parseTaskRequest(value);
}

/**
 * The parameters a task agent gets when it declares no input schema: `goal`
 * and `background`, both optional.
 *
 * Mirrors `_DefaultTaskInput` in adk-python
 * `agents/llm/task/_task_models.py`. adk-python declares a second, unrelated
 * `_DefaultTaskInput` in `tools/agent_tool.py` that holds one required
 * `request` string. The two are different shapes for different tools, so do
 * not substitute one for the other.
 */
export const DEFAULT_TASK_INPUT_SCHEMA: Schema = {
  type: Type.OBJECT,
  properties: {
    goal: {
      type: Type.STRING,
      description: 'The goal or objective for the task agent.',
    },
    background: {
      type: Type.STRING,
      description: 'Additional background context for the task agent.',
    },
  },
};

/**
 * The parameters {@link FinishTaskTool} declares when the task agent declares
 * no output schema.
 *
 * Mirrors `_DefaultTaskOutput` in adk-python
 * `agents/llm/task/_task_models.py`.
 */
export const DEFAULT_TASK_OUTPUT_SCHEMA: Schema = {
  type: Type.OBJECT,
  properties: {
    result: {
      type: Type.STRING,
      description: 'A brief summary of what the agent accomplished.',
    },
  },
  required: ['result'],
};
