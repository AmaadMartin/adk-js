/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {describe, expect, it} from 'vitest';
import {VertexAiLanguage} from '../../src/utils/vertex_ai_internal.js';

/**
 * `VertexAiLanguage` is the adapter's only runtime re-export: everything else
 * it exposes is `export type` and is erased before execution. These assertions
 * pin the one thing that can silently break — the enum surviving the CommonJS
 * to ESM re-export — which would otherwise surface as an `undefined` member
 * deep inside AgentEngineSandboxCodeExecutor.
 */
describe('vertex_ai_internal', () => {
  describe('VertexAiLanguage', () => {
    it('re-exports the upstream enum as a runtime value', () => {
      expect(VertexAiLanguage.LANGUAGE_UNSPECIFIED).toBe(
        'LANGUAGE_UNSPECIFIED',
      );
      expect(VertexAiLanguage.LANGUAGE_PYTHON).toBe('LANGUAGE_PYTHON');
      expect(VertexAiLanguage.LANGUAGE_JAVASCRIPT).toBe('LANGUAGE_JAVASCRIPT');
    });
  });
});
