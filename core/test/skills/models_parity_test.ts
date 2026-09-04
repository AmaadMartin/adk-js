/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Ported from adk-python tests/unittests/skills/test_models.py
 * (github.com/google/adk-python, main). All 27 of its tests are here under
 * their Python names. test_script_to_string calls scriptToString, because
 * `String()` on a plain object cannot reach a structural type.
 */

import {
  FeatureName,
  getAsset,
  getReference,
  getScript,
  listAssets,
  listReferences,
  listScripts,
  Resources,
  Script,
  scriptToString,
  Skill,
  skillDescription,
  skillName,
  withTemporaryFeatureOverride,
} from '@google/adk';
import {describe, expect, it} from 'vitest';
import {FrontmatterSchema} from '../../src/skills/skill.js';

describe('models parity', () => {
  it('test_frontmatter', () => {
    const frontmatter = FrontmatterSchema.parse({
      name: 'test-skill',
      description: 'Test description',
      license: 'Apache 2.0',
      compatibility: 'test',
      'allowed-tools': 'test',
      metadata: {key: 'value'},
    });

    expect(frontmatter.name).toBe('test-skill');
    expect(frontmatter.description).toBe('Test description');
    expect(frontmatter.license).toBe('Apache 2.0');
    expect(frontmatter.compatibility).toBe('test');
    expect(frontmatter.allowedTools).toBe('test');
    expect(frontmatter.metadata).toEqual({key: 'value'});
  });

  it('test_resources', () => {
    const resources: Resources = {
      references: {ref1: 'ref content'},
      assets: {asset1: 'asset content'},
      scripts: {script1: {src: "print('hello')"}},
    };

    expect(getReference(resources, 'ref1')).toBe('ref content');
    expect(getAsset(resources, 'asset1')).toBe('asset content');
    expect(getScript(resources, 'script1')?.src).toBe("print('hello')");
    expect(getReference(resources, 'ref2')).toBeUndefined();
    expect(getAsset(resources, 'asset2')).toBeUndefined();
    expect(getScript(resources, 'script2')).toBeUndefined();
    expect(listReferences(resources)).toEqual(['ref1']);
    expect(listAssets(resources)).toEqual(['asset1']);
    expect(listScripts(resources)).toEqual(['script1']);
  });

  it('test_skill_properties', () => {
    const skill: Skill = {
      frontmatter: FrontmatterSchema.parse({
        name: 'my-skill',
        description: 'my description',
      }),
      instructions: 'do this',
    };

    expect(skill.frontmatter.name).toBe('my-skill');
    expect(skill.frontmatter.description).toBe('my description');
    expect(skillName(skill)).toBe('my-skill');
    expect(skillDescription(skill)).toBe('my description');
    expect(skill.uri).toBeUndefined();
  });

  it('test_script_to_string', () => {
    const script: Script = {src: "print('hello')"};

    expect(scriptToString(script)).toBe("print('hello')");
  });

  // --- Name validation tests ---

  it('test_name_too_long', () => {
    expect(() =>
      FrontmatterSchema.parse({name: 'a'.repeat(65), description: 'desc'}),
    ).toThrow('at most 64 characters');
  });

  it('test_name_uppercase_rejected', () => {
    expect(() =>
      FrontmatterSchema.parse({name: 'My-Skill', description: 'desc'}),
    ).toThrow('lowercase kebab-case');
  });

  it('test_name_leading_hyphen', () => {
    expect(() =>
      FrontmatterSchema.parse({name: '-my-skill', description: 'desc'}),
    ).toThrow('lowercase kebab-case');
  });

  it('test_name_trailing_hyphen', () => {
    expect(() =>
      FrontmatterSchema.parse({name: 'my-skill-', description: 'desc'}),
    ).toThrow('lowercase kebab-case');
  });

  it('test_name_consecutive_hyphens', () => {
    expect(() =>
      FrontmatterSchema.parse({name: 'my--skill', description: 'desc'}),
    ).toThrow('lowercase kebab-case');
  });

  it('test_name_underscore_rejected_by_default', () => {
    expect(() =>
      FrontmatterSchema.parse({name: 'my_skill', description: 'desc'}),
    ).toThrow('lowercase kebab-case');
  });

  it('test_name_valid_underscore_preserved_with_flag', async () => {
    await withTemporaryFeatureOverride(
      FeatureName.SNAKE_CASE_SKILL_NAME,
      true,
      () => {
        const frontmatter = FrontmatterSchema.parse({
          name: 'my_skill',
          description: 'desc',
        });
        expect(frontmatter.name).toBe('my_skill');
      },
    );
  });

  it('test_name_invalid_chars_ampersand', () => {
    expect(() =>
      FrontmatterSchema.parse({name: 'skill&name', description: 'desc'}),
    ).toThrow('name must be lowercase kebab-case');
  });

  it('test_name_mixed_delimiters_rejected_by_default', () => {
    expect(() =>
      FrontmatterSchema.parse({name: 'my-skill_1', description: 'desc'}),
    ).toThrow('name must be lowercase kebab-case');
  });

  it('test_name_mixed_delimiters_rejected_with_flag', async () => {
    await withTemporaryFeatureOverride(
      FeatureName.SNAKE_CASE_SKILL_NAME,
      true,
      () => {
        expect(() =>
          FrontmatterSchema.parse({name: 'my-skill_1', description: 'desc'}),
        ).toThrow('Mixing hyphens and underscores is not allowed');
      },
    );
  });

  it('test_name_valid_passes', () => {
    const frontmatter = FrontmatterSchema.parse({
      name: 'my-skill-2',
      description: 'desc',
    });
    expect(frontmatter.name).toBe('my-skill-2');
  });

  it('test_name_single_word', () => {
    const frontmatter = FrontmatterSchema.parse({
      name: 'skill',
      description: 'desc',
    });
    expect(frontmatter.name).toBe('skill');
  });

  // --- Description validation tests ---

  it('test_description_empty', () => {
    expect(() =>
      FrontmatterSchema.parse({name: 'my-skill', description: ''}),
    ).toThrow('must not be empty');
  });

  it('test_description_too_long', () => {
    expect(() =>
      FrontmatterSchema.parse({
        name: 'my-skill',
        description: 'x'.repeat(1025),
      }),
    ).toThrow('at most 1024 characters. Description length: 1025');
  });

  // --- Compatibility validation tests ---

  it('test_compatibility_too_long', () => {
    expect(() =>
      FrontmatterSchema.parse({
        name: 'my-skill',
        description: 'desc',
        compatibility: 'c'.repeat(501),
      }),
    ).toThrow('at most 500 characters');
  });

  // --- Extra field allowed ---

  it('test_extra_field_allowed', () => {
    const frontmatter = FrontmatterSchema.parse({
      name: 'my-skill',
      description: 'desc',
      unknown_field: 'value',
    });
    expect(frontmatter.name).toBe('my-skill');
  });

  // --- allowed-tools alias ---

  it('test_allowed_tools_alias_via_model_validate', () => {
    const frontmatter = FrontmatterSchema.parse({
      name: 'my-skill',
      description: 'desc',
      'allowed-tools': 'tool-pattern',
    });
    expect(frontmatter.allowedTools).toBe('tool-pattern');
  });

  it('test_allowed_tools_serialization_alias', () => {
    // Adapted: TypeScript has no pydantic `model_dump(by_alias=True)`. The
    // parsed object keeps the YAML `allowed-tools` key next to the camelCase
    // one, so a caller that re-serializes it emits the aliased spelling.
    const frontmatter = FrontmatterSchema.parse({
      name: 'my-skill',
      description: 'desc',
      'allowed-tools': 'tool-pattern',
    });
    expect(frontmatter['allowed-tools']).toBe('tool-pattern');
    expect(frontmatter.allowedTools).toBe('tool-pattern');
  });

  it('test_metadata_adk_additional_tools_list', () => {
    const frontmatter = FrontmatterSchema.parse({
      name: 'my-skill',
      description: 'desc',
      metadata: {adk_additional_tools: ['tool1', 'tool2']},
    });
    expect(frontmatter.metadata['adk_additional_tools']).toEqual([
      'tool1',
      'tool2',
    ]);
  });

  it('test_metadata_adk_additional_tools_rejected_as_string', () => {
    expect(() =>
      FrontmatterSchema.parse({
        name: 'my-skill',
        description: 'desc',
        metadata: {adk_additional_tools: 'tool1 tool2'},
      }),
    ).toThrow('adk_additional_tools must be a list of strings');
  });

  it('test_metadata_adk_additional_tools_invalid_type', () => {
    expect(() =>
      FrontmatterSchema.parse({
        name: 'my-skill',
        description: 'desc',
        metadata: {adk_additional_tools: 123},
      }),
    ).toThrow('adk_additional_tools must be a list of strings');
  });

  it('test_metadata_adk_inject_state_bool', () => {
    const frontmatter = FrontmatterSchema.parse({
      name: 'my-skill',
      description: 'desc',
      metadata: {adk_inject_state: true},
    });
    expect(frontmatter.metadata['adk_inject_state']).toBe(true);
  });

  it('test_metadata_adk_inject_state_rejected_as_string', () => {
    expect(() =>
      FrontmatterSchema.parse({
        name: 'my-skill',
        description: 'desc',
        metadata: {adk_inject_state: 'true'},
      }),
    ).toThrow('adk_inject_state must be a bool');
  });
});
