/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  Context,
  InvocationContext,
  LoadSkillErrorCode,
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

  describe('error codes', () => {
    it('exposes stable string values for the error-code enum', () => {
      // The error-code string values are part of the tool's response contract
      // and must remain stable across releases.
      expect(LoadSkillErrorCode.MISSING_SKILL_NAME).toBe('MISSING_SKILL_NAME');
      expect(LoadSkillErrorCode.REGISTRY_ERROR).toBe('REGISTRY_ERROR');
      expect(LoadSkillErrorCode.SKILL_NOT_FOUND).toBe('SKILL_NOT_FOUND');
    });
  });
});
