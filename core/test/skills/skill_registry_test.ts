/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Frontmatter, Skill, SkillRegistry} from '@google/adk';
import {describe, expect, it} from 'vitest';

class DummySkillRegistry extends SkillRegistry {
  async getSkill(params: {name: string}): Promise<Skill> {
    return {
      frontmatter: {name: params.name, description: 'Dummy description'},
      instructions: 'Dummy instructions',
    };
  }

  async searchSkills(params: {query: string}): Promise<Frontmatter[]> {
    return [
      {
        name: 'dummy-skill',
        description: `Dummy description for ${params.query}`,
      },
    ];
  }
}

describe('SkillRegistry', () => {
  it('returns null for searchToolDescription by default', () => {
    const registry = new DummySkillRegistry();
    expect(registry.searchToolDescription()).toBeNull();
  });

  it('can fetch skill using subclass implementation', async () => {
    const registry = new DummySkillRegistry();
    const skill = await registry.getSkill({name: 'my-skill'});
    expect(skill.frontmatter.name).toBe('my-skill');
  });

  it('can search skills using subclass implementation', async () => {
    const registry = new DummySkillRegistry();
    const results = await registry.searchSkills({query: 'search-query'});
    expect(results).toHaveLength(1);
    expect(results[0].name).toBe('dummy-skill');
  });
});
