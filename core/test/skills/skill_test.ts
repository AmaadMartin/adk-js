/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  getAsset,
  getReference,
  getScript,
  listAssets,
  listReferences,
  listScripts,
} from '@google/adk';
import {afterEach, describe, expect, it} from 'vitest';
import {
  FrontmatterSchema,
  KEBAB_NAME_PATTERN,
  SNAKE_OR_KEBAB_NAME_PATTERN,
} from '../../src/skills/skill.js';

describe('skill', () => {
  describe('SNAKE_OR_KEBAB_NAME_PATTERN', () => {
    it('matches valid kebab-case names', () => {
      expect(SNAKE_OR_KEBAB_NAME_PATTERN.test('valid-kebab-name')).toBe(true);
      expect(SNAKE_OR_KEBAB_NAME_PATTERN.test('valid123-name')).toBe(true);
      expect(SNAKE_OR_KEBAB_NAME_PATTERN.test('name')).toBe(true);
    });

    it('matches valid snake_case names', () => {
      expect(SNAKE_OR_KEBAB_NAME_PATTERN.test('valid_snake_name')).toBe(true);
      expect(SNAKE_OR_KEBAB_NAME_PATTERN.test('valid123_name')).toBe(true);
    });

    it('does not match mixed case or invalid characters', () => {
      expect(SNAKE_OR_KEBAB_NAME_PATTERN.test('Invalid-Name')).toBe(false);
      expect(SNAKE_OR_KEBAB_NAME_PATTERN.test('invalid_Name')).toBe(false);
      expect(SNAKE_OR_KEBAB_NAME_PATTERN.test('invalid.name')).toBe(false);
      expect(SNAKE_OR_KEBAB_NAME_PATTERN.test('invalid name')).toBe(false);
    });

    it('does not match mixed hyphens and underscores', () => {
      expect(SNAKE_OR_KEBAB_NAME_PATTERN.test('invalid-snake_name')).toBe(
        false,
      );
      expect(SNAKE_OR_KEBAB_NAME_PATTERN.test('invalid_kebab-name')).toBe(
        false,
      );
    });

    it('does not match consecutive delimiters', () => {
      expect(SNAKE_OR_KEBAB_NAME_PATTERN.test('invalid--name')).toBe(false);
      expect(SNAKE_OR_KEBAB_NAME_PATTERN.test('invalid__name')).toBe(false);
    });

    it('does not match leading or trailing delimiters', () => {
      expect(SNAKE_OR_KEBAB_NAME_PATTERN.test('-invalid-name')).toBe(false);
      expect(SNAKE_OR_KEBAB_NAME_PATTERN.test('invalid-name-')).toBe(false);
      expect(SNAKE_OR_KEBAB_NAME_PATTERN.test('_invalid_name')).toBe(false);
      expect(SNAKE_OR_KEBAB_NAME_PATTERN.test('invalid_name_')).toBe(false);
    });
  });

  describe('FrontmatterSchema', () => {
    const validFrontmatter = {
      name: 'valid-skill-name',
      description: 'A valid description',
    };

    it('validates valid frontmatter', () => {
      const result = FrontmatterSchema.safeParse(validFrontmatter);
      expect(result.success).toBe(true);
    });

    it('validates frontmatter with optional fields', () => {
      const result = FrontmatterSchema.safeParse({
        ...validFrontmatter,
        license: 'Apache-2.0',
        compatibility: '>=1.0.0',
        'allowed-tools': 'tool1,tool2',
      });
      expect(result.success).toBe(true);
    });

    it('maps allowed-tools to allowedTools', () => {
      const result = FrontmatterSchema.safeParse({
        ...validFrontmatter,
        'allowed-tools': 'tool1,tool2',
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.allowedTools).toBe('tool1,tool2');
      }
    });

    it('preserves allowedTools if provided directly', () => {
      const result = FrontmatterSchema.safeParse({
        ...validFrontmatter,
        allowedTools: 'tool1,tool2',
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.allowedTools).toBe('tool1,tool2');
      }
    });

    it('fails on invalid name', () => {
      const result = FrontmatterSchema.safeParse({
        ...validFrontmatter,
        name: 'Invalid Name',
      });
      expect(result.success).toBe(false);
    });

    it('fails on too long name', () => {
      const result = FrontmatterSchema.safeParse({
        ...validFrontmatter,
        name: 'a'.repeat(65),
      });
      expect(result.success).toBe(false);
    });

    it('fails on empty description', () => {
      const result = FrontmatterSchema.safeParse({
        ...validFrontmatter,
        description: '',
      });
      expect(result.success).toBe(false);
    });

    it('fails on too long description', () => {
      const result = FrontmatterSchema.safeParse({
        ...validFrontmatter,
        description: 'a'.repeat(1025),
      });
      expect(result.success).toBe(false);
    });

    describe('metadata refinement', () => {
      it('allows metadata without adk_additional_tools', () => {
        const result = FrontmatterSchema.safeParse({
          ...validFrontmatter,
          metadata: {
            foo: 'bar',
          },
        });
        expect(result.success).toBe(true);
      });

      it('allows metadata with valid adk_additional_tools', () => {
        const result = FrontmatterSchema.safeParse({
          ...validFrontmatter,
          metadata: {
            adk_additional_tools: ['tool1', 'tool2'],
          },
        });
        expect(result.success).toBe(true);
      });

      it('fails when adk_additional_tools is not an array', () => {
        const result = FrontmatterSchema.safeParse({
          ...validFrontmatter,
          metadata: {
            adk_additional_tools: 'tool1',
          },
        });
        expect(result.success).toBe(false);
      });

      it('fails when adk_additional_tools contains non-strings', () => {
        const result = FrontmatterSchema.safeParse({
          ...validFrontmatter,
          metadata: {
            adk_additional_tools: ['tool1', 123],
          },
        });
        expect(result.success).toBe(false);
      });
    });
  });

  describe('non-object input', () => {
    it.each([['a string'], [null], [42]])(
      'rejects %o without preprocessing it',
      (input) => {
        expect(FrontmatterSchema.safeParse(input).success).toBe(false);
      },
    );
  });

  describe('KEBAB_NAME_PATTERN', () => {
    it('matches the same kebab-case names as SNAKE_OR_KEBAB_NAME_PATTERN', () => {
      expect(KEBAB_NAME_PATTERN.test('valid-kebab-name')).toBe(true);
      expect(KEBAB_NAME_PATTERN.test('valid123-name')).toBe(true);
      expect(KEBAB_NAME_PATTERN.test('name')).toBe(true);
    });

    it('does not match snake_case names', () => {
      expect(KEBAB_NAME_PATTERN.test('valid_snake_name')).toBe(false);
      expect(KEBAB_NAME_PATTERN.test('valid123_name')).toBe(false);
    });

    it('does not match leading, trailing or consecutive hyphens', () => {
      expect(KEBAB_NAME_PATTERN.test('-invalid-name')).toBe(false);
      expect(KEBAB_NAME_PATTERN.test('invalid-name-')).toBe(false);
      expect(KEBAB_NAME_PATTERN.test('invalid--name')).toBe(false);
    });
  });

  describe('NFKC name normalization', () => {
    it('folds a full-width name and returns the folded value', () => {
      const result = FrontmatterSchema.safeParse({
        name: 'ｍｙ－ｓｋｉｌｌ',
        description: 'A valid description',
      });

      expect(result.success).toBe(true);
      if (!result.success) {
        expect.fail(result.error.message);
      }
      expect(result.data.name).toBe('my-skill');
    });

    it('folds a ligature before the pattern check', () => {
      const result = FrontmatterSchema.safeParse({
        name: 'ﬁle-skill',
        description: 'A valid description',
      });

      expect(result.success).toBe(true);
      if (!result.success) {
        expect.fail(result.error.message);
      }
      expect(result.data.name).toBe('file-skill');
    });

    it('measures the length after folding, not before', () => {
      // 33 ligatures are 33 characters, and 66 once NFKC expands each to 'fi'.
      const result = FrontmatterSchema.safeParse({
        name: 'ﬁ'.repeat(33),
        description: 'A valid description',
      });

      expect(result.success).toBe(false);
      if (result.success) {
        expect.fail('expected the normalized name to exceed 64 characters');
      }
      expect(result.error.message).toContain('at most 64 characters');
    });
  });

  describe('ADK_ENABLE_SNAKE_CASE_SKILL_NAME', () => {
    afterEach(() => {
      delete process.env['ADK_ENABLE_SNAKE_CASE_SKILL_NAME'];
    });

    it('accepts a snake_case name when the env var is set', () => {
      process.env['ADK_ENABLE_SNAKE_CASE_SKILL_NAME'] = 'true';

      const result = FrontmatterSchema.safeParse({
        name: 'my_skill',
        description: 'A valid description',
      });

      expect(result.success).toBe(true);
      if (!result.success) {
        expect.fail(result.error.message);
      }
      expect(result.data.name).toBe('my_skill');
    });

    it('rejects a snake_case name once the env var is gone', () => {
      const result = FrontmatterSchema.safeParse({
        name: 'my_skill',
        description: 'A valid description',
      });

      expect(result.success).toBe(false);
    });
  });

  describe('resource accessors on absent fields', () => {
    it('returns undefined when the resources are undefined', () => {
      expect(getReference(undefined, 'x')).toBeUndefined();
      expect(getAsset(undefined, 'x')).toBeUndefined();
      expect(getScript(undefined, 'x')).toBeUndefined();
    });

    it('returns an empty list when the resource map is absent', () => {
      expect(listReferences({})).toEqual([]);
      expect(listAssets({})).toEqual([]);
      expect(listScripts({})).toEqual([]);
      expect(listReferences(undefined)).toEqual([]);
      expect(listAssets(undefined)).toEqual([]);
      expect(listScripts(undefined)).toEqual([]);
    });
  });
});
