/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {InputValidationError} from '../errors/input_validation_error.js';

import type {BaseToolParams} from './base_tool.js';

/**
 * The args of a tool config, as free-form key/value pairs.
 *
 * A config comes from outside the type system — a config file, not a call
 * site — so the shape is whatever the tool's own constructor accepts. Mirrors
 * Python's `ToolArgsConfig`, a pydantic model declared with `extra="allow"`.
 */
export type ToolArgsConfig = Record<string, unknown>;

/**
 * Names the runtime kind of a value for an error message.
 *
 * `typeof` reports both `null` and an array as `'object'`, which is the least
 * useful answer for someone reading a config error.
 */
function describeType(value: unknown): string {
  if (value === null) {
    return 'null';
  }
  if (Array.isArray(value)) {
    return 'array';
  }
  return typeof value;
}

/**
 * Builds the error for a config key that holds the wrong kind of value.
 *
 * The message names the key and the kind received. It never quotes the value:
 * a config can carry a credential, and error strings reach logs.
 */
function invalidType(
  key: string,
  expected: string,
  value: unknown,
): InputValidationError {
  return new InputValidationError(
    `Invalid tool config: "${key}" must be ${expected}, got ${describeType(value)}.`,
  );
}

/**
 * Validates a tool config into the parameters every tool constructor takes.
 *
 * The three keys `BaseTool` itself reads are checked. Every other key is
 * forwarded unchanged, so a subclass that inherits
 * {@link BaseTool.fromConfig} still receives its own options. Python reflects
 * over the constructor signature to decide what to forward; TypeScript erases
 * types at runtime, so passing the bag through is the closest equivalent that
 * loses nothing.
 *
 * @param config The args block of a tool config.
 * @return The validated constructor parameters.
 * @throws InputValidationError When a recognized key holds the wrong type.
 */
export function toBaseToolParams(config: ToolArgsConfig): BaseToolParams {
  const {name, description, isLongRunning, ...rest} = config;

  if (typeof name !== 'string') {
    throw invalidType('name', 'a string', name);
  }
  if (name.length === 0) {
    throw new InputValidationError(
      'Invalid tool config: "name" must not be empty.',
    );
  }
  if (typeof description !== 'string') {
    throw invalidType('description', 'a string', description);
  }
  if (isLongRunning !== undefined && typeof isLongRunning !== 'boolean') {
    throw invalidType('isLongRunning', 'a boolean', isLongRunning);
  }

  return {...rest, name, description, isLongRunning};
}
