/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  Context,
  InvocationContext,
  SearchSkillsTool,
  Skill,
  SkillRegistry,
  SkillToolset,
} from '@google/adk';
import {describe, expect, it, vi} from 'vitest';

describe('SearchSkillsTool', () => {
  const mockRegistry: SkillRegistry = {
    getSkill: vi.fn(),
    searchSkills: vi.fn(),
    searchToolDescription: vi.fn().mockReturnValue(null),
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
    const toolset = new SkillToolset([]);
    expect(() => new SearchSkillsTool(toolset)).toThrow(
      'SearchSkillsTool requires a configured skill registry.',
    );
  });

  it('uses registry search tool description if provided', () => {
    const customDescRegistry: SkillRegistry = {
      ...mockRegistry,
      searchToolDescription: vi
        .fn()
        .mockReturnValue('Custom search description'),
    };
    const toolset = new SkillToolset([], {registry: customDescRegistry});
    const tool = new SearchSkillsTool(toolset);
    expect(tool.description).toBe('Custom search description');
  });

  it('returns error if query argument is missing', async () => {
    const toolset = new SkillToolset([], {registry: mockRegistry});
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

  it('successfully searches registry and filters out locally loaded skills', async () => {
    const localSkill: Skill = {
      frontmatter: {name: 'local-skill', description: 'desc'},
      instructions: 'instructions',
    };
    const toolset = new SkillToolset([localSkill], {registry: mockRegistry});
    const tool = new SearchSkillsTool(toolset);

    vi.spyOn(mockRegistry, 'searchSkills').mockResolvedValue([
      {name: 'local-skill', description: 'desc'},
      {name: 'remote-skill', description: 'remote desc'},
    ]);

    const result = await tool.runAsync({
      args: {query: 'test-query'},
      toolContext: createMockContext(),
    });

    expect(mockRegistry.searchSkills).toHaveBeenCalledWith({
      query: 'test-query',
    });
    expect(result).toEqual([
      {name: 'remote-skill', description: 'remote desc'},
    ]);
  });

  it('returns error if registry search throws', async () => {
    const toolset = new SkillToolset([], {registry: mockRegistry});
    const tool = new SearchSkillsTool(toolset);

    vi.spyOn(mockRegistry, 'searchSkills').mockRejectedValue(
      new Error('Search failed'),
    );

    const result = await tool.runAsync({
      args: {query: 'test-query'},
      toolContext: createMockContext(),
    });

    expect(result).toEqual({
      error: 'Failed to search skills from registry: Search failed',
      error_code: 'REGISTRY_ERROR',
    });
  });
});
