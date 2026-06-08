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

  function createMockContext(agentName = 'test-agent') {
    return new Context({
      invocationContext: {
        session: {state: {}},
        agent: {name: agentName},
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

  it('returns error if skill name is missing', async () => {
    const toolset = new SkillToolset([mockSkill]);
    const tool = new LoadSkillTool(toolset);
    const result = await tool.runAsync({
      args: {},
      toolContext: createMockContext(),
    });
    expect(result).toEqual({
      error: 'Skill name is required.',
      error_code: 'MISSING_SKILL_NAME',
    });
  });

  it('returns error on registry fetch failure', async () => {
    const toolset = new SkillToolset([]);
    // Mock getOrFetchSkill to throw
    vi.spyOn(toolset, 'getOrFetchSkill').mockRejectedValue(
      new Error('Registry connection error'),
    );

    const tool = new LoadSkillTool(toolset);
    const result = await tool.runAsync({
      args: {name: 'test-skill'},
      toolContext: createMockContext(),
    });
    expect(result).toEqual({
      error:
        "Failed to fetch skill 'test-skill' from registry: Error: Registry connection error",
      error_code: 'REGISTRY_ERROR',
    });
  });
});
