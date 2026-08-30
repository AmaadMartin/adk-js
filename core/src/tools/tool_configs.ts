/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {FunctionResponseScheduling} from '@google/genai';

import {InputValidationError} from '../errors/input_validation_error.js';
import {logger} from '../utils/logger.js';

import type {BaseToolParams} from './base_tool.js';

/**
 * The args of a tool config, as free-form key/value pairs.
 *
 * A config comes from outside the type system, so the shape is whatever the
 * tool's own constructor accepts. `BaseTool.fromConfig` validates the keys it
 * understands and ignores the rest.
 */
export type ToolArgsConfig = Record<string, unknown>;

/** The keys {@link toBaseToolParams} maps onto `BaseToolParams`. */
const BASE_TOOL_PARAM_KEYS: ReadonlySet<string> = new Set([
  'name',
  'description',
  'isLongRunning',
  'customMetadata',
  'responseScheduling',
]);

const SCHEDULING_VALUES: readonly string[] = Object.values(
  FunctionResponseScheduling,
);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isResponseScheduling(
  value: unknown,
): value is FunctionResponseScheduling {
  return typeof value === 'string' && SCHEDULING_VALUES.includes(value);
}

function describeType(value: unknown): string {
  if (value === null) {
    return 'null';
  }
  return Array.isArray(value) ? 'array' : typeof value;
}

function invalidToolConfig(
  key: string,
  expected: string,
  value: unknown,
): InputValidationError {
  return new InputValidationError(
    `Invalid tool config: "${key}" must be ${expected}, got ${describeType(value)}.`,
  );
}

/**
 * Validates the keys of `BaseToolParams` in a tool config.
 *
 * A key this mapper does not recognize is a warning, not an error: a subclass
 * config legitimately carries keys only its own `fromConfig` override reads.
 *
 * @param config The args of the tool config.
 * @return The validated constructor params.
 * @throws {InputValidationError} If a recognized key is missing or holds a
 *     value of the wrong type.
 */
export function toBaseToolParams(config: ToolArgsConfig): BaseToolParams {
  const {name, description, isLongRunning, customMetadata, responseScheduling} =
    config;
  for (const key of Object.keys(config)) {
    if (!BASE_TOOL_PARAM_KEYS.has(key)) {
      logger.warn(`Unsupported parsing for tool config argument: ${key}.`);
    }
  }
  if (typeof name !== 'string') {
    throw invalidToolConfig('name', 'a string', name);
  }
  if (name === '') {
    throw new InputValidationError(
      'Invalid tool config: "name" must not be empty.',
    );
  }
  if (typeof description !== 'string') {
    throw invalidToolConfig('description', 'a string', description);
  }
  if (isLongRunning !== undefined && typeof isLongRunning !== 'boolean') {
    throw invalidToolConfig('isLongRunning', 'a boolean', isLongRunning);
  }
  if (customMetadata !== undefined && !isPlainObject(customMetadata)) {
    throw invalidToolConfig('customMetadata', 'an object', customMetadata);
  }
  if (
    responseScheduling !== undefined &&
    !isResponseScheduling(responseScheduling)
  ) {
    throw invalidToolConfig(
      'responseScheduling',
      `one of ${SCHEDULING_VALUES.join(', ')}`,
      responseScheduling,
    );
  }
  return {
    name,
    description,
    isLongRunning,
    customMetadata,
    responseScheduling,
  };
}
