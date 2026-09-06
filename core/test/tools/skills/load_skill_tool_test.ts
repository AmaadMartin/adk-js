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
import {describe, expect, it} from 'vitest';

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

  it('declares skill_name as the required argument', () => {
    const tool = new LoadSkillTool(new SkillToolset([mockSkill]));

    const parameters = tool._getDeclaration().parameters;

    expect(Object.keys(parameters?.properties ?? {})).toEqual(['skill_name']);
    expect(parameters?.required).toEqual(['skill_name']);
  });

  it('rejects the legacy name argument', async () => {
    const tool = new LoadSkillTool(new SkillToolset([mockSkill]));

    const result = await tool.runAsync({
      args: {name: 'test-skill'},
      toolContext: createMockContext(),
    });

    expect(result).toEqual({
      error: "Argument 'skill_name' is required.",
      error_code: 'MISSING_SKILL_NAME',
    });
  });

  it('loads skill instructions and updates state', async () => {
    const toolset = new SkillToolset([mockSkill]);
    const tool = new LoadSkillTool(toolset);

    const toolContext = createMockContext('test-agent');

    const result = await tool.runAsync({
      args: {skill_name: 'test-skill'},
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
      args: {skill_name: 'unknown-skill'},
      toolContext: createMockContext(),
    });
    expect(result).toEqual({
      error: "Skill 'unknown-skill' not found.",
      error_code: 'SKILL_NOT_FOUND',
    });
  });
});
