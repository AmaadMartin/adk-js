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
    why: 'the variant is Vertex AI and the model is Gemini 2.0+',
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
    why: 'the variant is Vertex AI and the model is Gemini 2.0+',
  },
  {
    model: 'gemini-1.5-pro',
    vertexEnv: 'true',
    expected: true,
    why: 'there is no version floor: every Gemini id qualifies on Vertex AI',
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
    why: 'the model id is read out of the path-based model name',
  },
  {
    model: 'gemini-flash-early-exp',
    vertexEnv: 'true',
    expected: true,
    why: 'an Early Access Program name is a Gemini id, even without a version',
  },
  {
    model: 'gemini-early-exp',
    vertexEnv: 'true',
    expected: true,
    why: 'an Early Access Program name is a Gemini id, even without a version',
  },
  {
    model: 'gemini-early-exp',
    vertexEnv: undefined,
    expected: false,
    why: 'the variant gates every model id',
  },
  {
    model: 'gemini-flash-early-exp3',
    vertexEnv: 'true',
    expected: true,
    why: 'a numeric Early Access Program suffix is not a version either',
  },
  {
    model: 'gemini-live-2.5-flash-native-audio',
    vertexEnv: 'true',
    expected: true,
    why: 'a word before the version does not stop it being a Gemini id',
  },
  {
    model: 'projects/p/locations/l/publishers/google/models/gemini-early-exp',
    vertexEnv: 'true',
    expected: true,
    why: 'an unversioned id is also read out of a path-based model name',
  },
  {
    model: 'gemma-3-27b-it',
    vertexEnv: 'true',
    expected: false,
    why: 'the "gemini-" prefix is required, and "gemma-" is a different family',
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
});
