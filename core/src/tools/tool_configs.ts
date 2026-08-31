/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {FunctionResponseScheduling} from '@google/genai';

import {InputValidationError} from '../errors/input_validation_error.js';

import type {BaseToolParams} from './base_tool.js';

/**
 * The args of a tool config, as free-form key/value pairs.
 *
 * A config comes from outside the type system, so the shape is whatever the
 * tool's own constructor accepts. `BaseTool.fromConfig` validates the keys it
 * understands and forwards the rest.
 */
export type ToolArgsConfig = Record<string, unknown>;

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
 * Validates the keys of `BaseToolParams` in a tool config and returns the whole
 * config as constructor params.
 *
 * Every key is forwarded, not just the recognized ones. A tool constructor
 * takes a single options object and TypeScript is structurally typed, so a
 * subclass that declares its own optional options reads them straight off the
 * forwarded bag without overriding `fromConfig`. A key no constructor reads is
 * inert. This mirrors the effect of adk-python's `from_config`, which populates
 * a subclass's own constructor parameters from the same bag.
 *
 * @param config The args of the tool config.
 * @return The config, with the validated base keys overlaid.
 * @throws {InputValidationError} If a recognized key is missing or holds a
 *     value of the wrong type.
 */
export function toBaseToolParams(
  config: ToolArgsConfig,
): BaseToolParams & ToolArgsConfig {
  const {name, description, isLongRunning, customMetadata, responseScheduling} =
    config;
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
    ...config,
    name,
    description,
    isLongRunning,
    customMetadata,
    responseScheduling,
  };
}
