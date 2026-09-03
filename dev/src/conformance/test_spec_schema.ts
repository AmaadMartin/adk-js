/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Content} from '@google/genai';
import {z} from 'zod';
import {TestSpec} from '../integration/test_types.js';

/**
 * A user message `content` is a genai `Content`, which adk-js cannot validate
 * field by field at runtime: `@google/genai` ships no schema for it, and a
 * hand-written mirror would duplicate the SDK types and go stale. The check
 * therefore stops at "is a mapping", and the type comes from the SDK.
 */
const contentSchema = z.custom<Content>(
  (value) =>
    typeof value === 'object' && value !== null && !Array.isArray(value),
  {message: 'Invalid input: expected a mapping'},
);

const userMessageSchema = z.strictObject({
  text: z.string().optional(),
  content: contentSchema.optional(),
  stateDelta: z.record(z.string(), z.unknown()).optional(),
});

/**
 * Mirrors adk-python's `TestSpec` pydantic model, which sets
 * `ConfigDict(extra="forbid")` and declares empty defaults for `initial_state`
 * and `user_messages`.
 *
 * The `satisfies` clause fails to compile if `TestSpec` gains a field that the
 * schema does not parse.
 */
const testSpecSchema = z.strictObject({
  description: z.string(),
  agent: z.string(),
  initialState: z.record(z.string(), z.unknown()).default({}),
  userMessages: z.array(userMessageSchema).default([]),
}) satisfies z.ZodType<TestSpec>;

/**
 * Validates a camelCased conformance spec and applies its declared defaults.
 *
 * Run this after `camelcaseKeys`, not before: a spec written in snake_case is
 * legitimate, and its keys only match the schema once they are camelCased.
 *
 * @param data The parsed `spec.yaml` mapping, already camelCased.
 * @returns The spec, with `initialState` and `userMessages` always populated.
 * @throws Error naming the offending key when the spec carries an unknown
 *   field, omits a required field, or gives a field the wrong type.
 */
export function parseTestSpec(data: unknown): TestSpec {
  const result = testSpecSchema.safeParse(data);
  if (!result.success) {
    throw new Error(`Invalid test spec:\n${z.prettifyError(result.error)}`);
  }
  return result.data;
}
