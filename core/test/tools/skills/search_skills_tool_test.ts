/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  Context,
  Frontmatter,
  InvocationContext,
  SearchSkillsTool,
  Skill,
  SkillRegistry,
  SkillToolset,
} from '@google/adk';
import {describe, expect, it, vi} from 'vitest';

class MockSkillRegistry extends SkillRegistry {
  getSkill = vi.fn();
  searchSkills = vi.fn();
  override searchToolDescription() {
    return 'Custom description';
  }
}

describe('SearchSkillsTool', () => {
  const mockSkill: Skill = {
    frontmatter: {
      name: 'local-skill',
      description: 'Local skill',
    },
    instructions: 'Local instructions',
  };

  function createMockContext() {
    return new Context({
      invocationContext: {
        session: {state: {}},
        agent: {name: 'test-agent'},
      } as unknown as InvocationContext,
    });
  }

  it('throws error in constructor if registry is missing', () => {
    const toolset = new SkillToolset([mockSkill]);
    expect(() => new SearchSkillsTool(toolset)).toThrow(
      'SearchSkillsTool requires a configured skill registry.',
    );
  });

  it('uses default description if searchToolDescription returns null', () => {
    const registry = new MockSkillRegistry();
    registry.searchToolDescription = vi.fn().mockReturnValue(null);
    const toolset = new SkillToolset([mockSkill], {registry});
    const tool = new SearchSkillsTool(toolset);
    expect(tool.description).toBe(
      'Searches for relevant skills in the registry based on a semantic or keyword query.',
    );
  });

  it('uses custom description if registry provides one', () => {
    const registry = new MockSkillRegistry();
    const toolset = new SkillToolset([mockSkill], {registry});
    const tool = new SearchSkillsTool(toolset);
    expect(tool.description).toBe('Custom description');
  });

  it('returns declaration parameters matching schema', () => {
    const registry = new MockSkillRegistry();
    const toolset = new SkillToolset([mockSkill], {registry});
    const tool = new SearchSkillsTool(toolset);
    const decl = tool._getDeclaration();
    expect(decl.name).toBe('search_skills');
    expect(decl.parameters?.required).toContain('query');
  });

  describe('runAsync', () => {
    it('returns error if query is missing', async () => {
      const registry = new MockSkillRegistry();
      const toolset = new SkillToolset([mockSkill], {registry});
      const tool = new SearchSkillsTool(toolset);
      const result = await tool.runAsync({
        args: {},
        toolContext: createMockContext(),
      });
      expect(result).toEqual({
        error: "Argument 'query' is required.",
        error_code: 'INVALID_ARGUMENTS',
      });
    });

    it('returns error if registry is missing at runtime', async () => {
      const toolset = new SkillToolset([mockSkill]);
      // bypass constructor guard for runtime check coverage
      const tool = Object.create(SearchSkillsTool.prototype);
      tool.toolset = toolset;
      const result = await tool.runAsync({
        args: {query: 'test'},
        toolContext: createMockContext(),
      });
      expect(result).toEqual({
        error: 'SearchSkillsTool requires a configured skill registry.',
        error_code: 'REGISTRY_ERROR',
      });
    });

    it('successfully searches and filters out locally defined skills', async () => {
      const registry = new MockSkillRegistry();
      const mockResults: Frontmatter[] = [
        {name: 'local-skill', description: 'Local skill'},
        {name: 'remote-skill', description: 'Remote skill'},
      ];
      registry.searchSkills.mockResolvedValue(mockResults);

      const toolset = new SkillToolset([mockSkill], {registry});
      const tool = new SearchSkillsTool(toolset);

      const result = await tool.runAsync({
        args: {query: 'test-query'},
        toolContext: createMockContext(),
      });

      expect(registry.searchSkills).toHaveBeenCalledWith({query: 'test-query'});
      expect(result).toEqual([
        {name: 'remote-skill', description: 'Remote skill'},
      ]);
    });

    it('returns registry error if searchSkills throws', async () => {
      const registry = new MockSkillRegistry();
      registry.searchSkills.mockRejectedValue(new Error('Search failed'));

      const toolset = new SkillToolset([mockSkill], {registry});
      const tool = new SearchSkillsTool(toolset);

      const result = await tool.runAsync({
        args: {query: 'test-query'},
        toolContext: createMockContext(),
      });

      expect(result).toEqual({
        error: 'Failed to search skills from registry: Error: Search failed',
        error_code: 'REGISTRY_ERROR',
      });
    });
  });
});
