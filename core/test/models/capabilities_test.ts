/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Ported from adk-python tests/unittests/models/test_capabilities.py (main).
 * The reference test names are kept verbatim as `it()` titles.
 */

import {createLlmCapabilities} from '@google/adk';
import {describe, expect, it} from 'vitest';
import {ZodError} from 'zod';

describe('LlmCapabilities', () => {
  it('test_capabilities_are_immutable', () => {
    const capabilities = createLlmCapabilities();

    expect(Object.isFrozen(capabilities)).toBe(true);
    // `Object.assign` writes the property the way an assignment would, without
    // a cast that would defeat the `readonly` field.
    expect(() =>
      Object.assign(capabilities, {outputSchemaAndTools: true}),
    ).toThrow(TypeError);
    expect(capabilities.outputSchemaAndTools).toBe(false);
  });

  it('test_unknown_capability_is_rejected', () => {
    expect(() => createLlmCapabilities({noSuchCapability: true})).toThrow(
      ZodError,
    );
  });

  it('test_model_copy_silently_ignores_an_unknown_capability', () => {
    // The reference asserts that pydantic's `model_copy(update=...)` skips
    // validation. That half has no TypeScript analogue. The half that carries
    // over is the documented override: building a new snapshot from an old one
    // validates the misspelling instead of attaching it.
    expect(() =>
      createLlmCapabilities({
        ...createLlmCapabilities(),
        outputSchemaWithTools: true,
      }),
    ).toThrow(ZodError);
  });

  it('defaults outputSchemaAndTools to false', () => {
    expect(createLlmCapabilities().outputSchemaAndTools).toBe(false);
  });

  it('keeps an explicitly granted capability', () => {
    const capabilities = createLlmCapabilities({outputSchemaAndTools: true});

    expect(capabilities.outputSchemaAndTools).toBe(true);
    expect(Object.isFrozen(capabilities)).toBe(true);
  });

  it('rejects a wrong-typed capability value', () => {
    expect(() => createLlmCapabilities({outputSchemaAndTools: 'yes'})).toThrow(
      ZodError,
    );
  });
});
