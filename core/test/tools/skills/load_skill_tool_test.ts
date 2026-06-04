/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  Context,
  InvocationContext,
  LoadSkillTool,
  Skill,
  SkillRegistry,
  SkillToolset,
} from '@google/adk';
import {describe, expect, it, vi} from 'vitest';

describe('LoadSkillTool', () => {
  const mockSkill: Skill = {
    frontmatter: {
      name: 'test-skill',
      description: 'A test skill',
    },
    instructions: 'Test instructions',
    resources: {
      references: {
        'doc.md': 'Doc content',
      },
      assets: {
        'image.png': Buffer.from('fake image data'),
      },
      scripts: {
        'run.sh': {src: 'echo hello'},
      },
    },
  };

  function createMockContext(
    agentName = 'test-agent',
    invocationId = 'default-inv-id',
  ) {
    return new Context({
      invocationContext: {
        session: {state: {}},
        agent: {name: agentName},
        invocationId,
      } as unknown as InvocationContext,
    });
  }

  it('loads skill instructions and updates state', async () => {
    const toolset = new SkillToolset([mockSkill]);
    const tool = new LoadSkillTool(toolset);

    const toolContext = createMockContext('test-agent');

    const result = await tool.runAsync({
      args: {name: 'test-skill'},
      toolContext,
    });

    expect(result).toEqual({
      skill_name: 'test-skill',
      instructions: 'Test instructions',
      frontmatter: mockSkill.frontmatter,
      resources: mockSkill.resources,
    });

    expect(toolContext.state.get('_adk_activated_skill_test-agent')).toEqual([
      'test-skill',
    ]);
  });

  it('returns error if skill not found', async () => {
    const toolset = new SkillToolset([]);
    const tool = new LoadSkillTool(toolset);
    const result = await tool.runAsync({
      args: {name: 'unknown-skill'},
      toolContext: createMockContext(),
    });
    expect(result).toEqual({
      error: "Skill 'unknown-skill' not found.",
      error_code: 'SKILL_NOT_FOUND',
    });
  });

  it('fetches skill from registry successfully', async () => {
    const mockRegistry: SkillRegistry = {
      getSkill: vi.fn().mockResolvedValue(mockSkill),
      searchSkills: vi.fn(),
      searchToolDescription: vi.fn(),
    };

    const toolset = new SkillToolset([], {registry: mockRegistry});
    const tool = new LoadSkillTool(toolset);

    const toolContext = createMockContext('test-agent', 'invocation-123');

    const result = await tool.runAsync({
      args: {name: 'test-skill'},
      toolContext,
    });

    expect(mockRegistry.getSkill).toHaveBeenCalledWith({name: 'test-skill'});
    expect(result).toEqual({
      skill_name: 'test-skill',
      instructions: 'Test instructions',
      frontmatter: mockSkill.frontmatter,
      resources: mockSkill.resources,
    });
  });

  it('returns registry error if registry fetch throws', async () => {
    const mockRegistry: SkillRegistry = {
      getSkill: vi.fn().mockRejectedValue(new Error('Registry fetch error')),
      searchSkills: vi.fn(),
      searchToolDescription: vi.fn(),
    };

    const toolset = new SkillToolset([], {registry: mockRegistry});
    const tool = new LoadSkillTool(toolset);

    const toolContext = createMockContext('test-agent', 'invocation-123');

    const result = await tool.runAsync({
      args: {name: 'test-skill'},
      toolContext,
    });

    expect(result).toEqual({
      error:
        "Failed to fetch skill 'test-skill' from registry: Registry fetch error",
      error_code: 'REGISTRY_ERROR',
    });
  });
});
