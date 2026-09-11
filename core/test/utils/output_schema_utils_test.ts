/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {afterEach, describe, expect, it, vi} from 'vitest';
// `canUseOutputSchemaWithTools` is internal and deliberately not exported from
// the package barrel.
import {canUseOutputSchemaWithTools} from '../../src/utils/output_schema_utils.js';

const VERTEX_ENV_VAR = 'GOOGLE_GENAI_USE_VERTEXAI';

interface TestCase {
  model: string;
  vertexEnv: string | undefined;
  expected: boolean;
  why: string;
}

const TEST_CASES: TestCase[] = [
  {
    model: 'gemini-2.5-pro',
    vertexEnv: 'true',
    expected: true,
    why: 'the variant is Vertex AI and the model is in the Gemini family',
  },
  {
    model: 'gemini-2.5-pro',
    vertexEnv: '1',
    expected: true,
    why: '"1" also selects the Vertex AI variant',
  },
  {
    model: 'gemini-2.5-pro',
    vertexEnv: 'false',
    expected: false,
    why: 'the variant is not Vertex AI',
  },
  {
    model: 'gemini-2.5-pro',
    vertexEnv: undefined,
    expected: false,
    why: 'the Gemini API variant is the default',
  },
  {
    model: 'gemini-2.5-flash',
    vertexEnv: 'true',
    expected: true,
    why: 'the variant is Vertex AI and the model is in the Gemini family',
  },
  {
    model: 'gemini-1.5-pro',
    vertexEnv: 'true',
    expected: true,
    why: 'the family test carries no version floor',
  },
  {
    model: 'gemini-1.5-pro',
    vertexEnv: undefined,
    expected: false,
    why: 'neither condition holds',
  },
  {
    model: 'claude-3-7-sonnet',
    vertexEnv: 'true',
    expected: false,
    why: 'it is not a Gemini model',
  },
  {
    model: '',
    vertexEnv: 'true',
    expected: false,
    why: 'an empty model name is never recognised',
  },
  {
    model: 'projects/p/locations/l/publishers/google/models/gemini-2.5-flash',
    vertexEnv: 'true',
    expected: true,
    why: 'the model name is read out of the path-based form',
  },
  {
    model: 'gemini-flash-early-exp',
    vertexEnv: 'true',
    expected: true,
    why: 'an Early Access Program name encodes no version and still qualifies',
  },
  {
    model: 'gemini-early-exp',
    vertexEnv: 'true',
    expected: true,
    why: 'this is the Early Access Program name the reference test uses',
  },
];

describe('canUseOutputSchemaWithTools', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  for (const {model, vertexEnv, expected, why} of TEST_CASES) {
    const envLabel = vertexEnv === undefined ? 'unset' : `"${vertexEnv}"`;
    it(`returns ${expected} for "${model}" with ${VERTEX_ENV_VAR} ${envLabel}: ${why}`, () => {
      vi.stubEnv(VERTEX_ENV_VAR, vertexEnv);

      expect(canUseOutputSchemaWithTools(model)).toBe(expected);
    });
  }

  it('follows a change of the variant environment variable', () => {
    vi.stubEnv(VERTEX_ENV_VAR, undefined);
    expect(canUseOutputSchemaWithTools('gemini-2.5-pro')).toBe(false);

    vi.stubEnv(VERTEX_ENV_VAR, 'true');

    expect(canUseOutputSchemaWithTools('gemini-2.5-pro')).toBe(true);
  });
});
