/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

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
 * Names the received type for a diagnostic message.
 *
 * `typeof` reports `'object'` for both `null` and an array, which is the case a
 * caller most needs to tell apart.
 *
 * @param value The value to name.
 * @returns The type name, mirroring Python's `type(value).__name__`.
 */
function typeNameOf(value: unknown): string {
  if (value === null) {
    return 'null';
  }
  if (Array.isArray(value)) {
    return 'Array';
  }
  return typeof value;
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

/**
 * Default input shape for a task agent that declares no input schema.
 *
 * This is the `goal`/`background` pair from adk-python's `_task_models.py`. It
 * is not the single-`request`-string `_DefaultTaskInput` that
 * `tools/agent_tool.py` declares; those are two distinct models in the
 * reference, and adk-js mirrors the other one as `DEFAULT_TASK_INPUT_SCHEMA` in
 * `agent_tool.ts`.
 */
export interface DefaultTaskInput {
  /** The goal or objective for the task agent. */
  readonly goal?: string;
  /** Additional background context for the task agent. */
  readonly background?: string;
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

/** `Optional[str] = None` in the reference: absent, null and a string all pass. */
const optionalText = (field: string) =>
  z
    .string({error: `${field} must be a string.`})
    .nullish()
    .transform((value) => value ?? undefined);

const defaultTaskInputSchema = z.strictObject({
  goal: optionalText('goal'),
  background: optionalText('background'),
});

/**
 * Validates a task delegation payload that arrives as `unknown`.
 *
 * A persisted payload can be written by either SDK, so `agent_name` is accepted
 * alongside `agentName`. The keys inside `input` are never rewritten.
 *
 * @param value The value to validate.
 * @returns A frozen request. A later write to it throws a `TypeError`.
 * @throws InputValidationError If the value is not a valid task request.
 */
export function parseTaskRequest(value: unknown): TaskRequest {
  const parsed = taskRequestSchema.safeParse(value);
  if (!parsed.success) {
    throw new InputValidationError(parsed.error.issues[0].message);
  }
  return Object.freeze(parsed.data);
}

/**
 * Validates a task completion payload that arrives as `unknown`.
 *
 * `output` is required but nullable, matching `Any` in the reference: the key
 * must be present, and its value may be anything including `null`.
 *
 * @param value The value to validate.
 * @returns A frozen result. A later write to it throws a `TypeError`.
 * @throws InputValidationError If the value is not a valid task result.
 */
export function parseTaskResult(value: unknown): TaskResult {
  const parsed = taskResultSchema.safeParse(value);
  if (!parsed.success) {
    throw new InputValidationError(parsed.error.issues[0].message);
  }
  return Object.freeze(parsed.data);
}

/**
 * Validates a default task input payload that arrives as `unknown`.
 *
 * @param value The value to validate.
 * @returns A frozen input. A later write to it throws a `TypeError`.
 * @throws InputValidationError If the value is not a valid default task input.
 */
export function parseDefaultTaskInput(value: unknown): DefaultTaskInput {
  const parsed = defaultTaskInputSchema.safeParse(value);
  if (!parsed.success) {
    throw new InputValidationError(parsed.error.issues[0].message);
  }
  return Object.freeze(parsed.data);
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
    logger.error(
      `Unexpected type for TaskRequest: ${typeNameOf(value)}. Expected an object.`,
    );
  }
  return parseTaskRequest(value);
}
