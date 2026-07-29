/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {CodeConfigSchema} from '@google/adk';
import {describe, expect, it} from 'vitest';

describe('agents/common_configs', () => {
  describe('CodeConfigSchema', () => {
    it('parses a valid code config', () => {
      const config = CodeConfigSchema.parse({name: 'my.module.my_function'});
      expect(config.name).toBe('my.module.my_function');
    });

    it('requires the name field', () => {
      expect(CodeConfigSchema.safeParse({}).success).toBe(false);
    });

    it('rejects unknown keys', () => {
      const result = CodeConfigSchema.safeParse({
        name: 'my.module.my_function',
        extra: 'not-allowed',
      });
      expect(result.success).toBe(false);
    });
  });
});
