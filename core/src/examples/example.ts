/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Content} from '@google/genai';

/**
 * A few-shot example.
 */
export interface Example {
  /**
   * The input content for the example.
   */
  input: Content;
  /**
   * The expected output content for the example.
   */
  output: Content[];
}

/**
 * Type guard to check if a value has the shape of an Example.
 *
 * The check is shallow. It reads the two required fields and does not validate
 * the `Content` inside them.
 *
 * @param value The value to check.
 * @return True if the value has the shape of an Example, false otherwise.
 */
export function isExample(value: unknown): value is Example {
  return (
    typeof value === 'object' &&
    value !== null &&
    'input' in value &&
    typeof value.input === 'object' &&
    value.input !== null &&
    'output' in value &&
    Array.isArray(value.output)
  );
}

/**
 * Type guard to check if a value is a list of Examples.
 *
 * @param value The value to check.
 * @return True if the value is an array of Examples, false otherwise.
 */
export function isExampleArray(value: unknown): value is Example[] {
  return Array.isArray(value) && value.every(isExample);
}
