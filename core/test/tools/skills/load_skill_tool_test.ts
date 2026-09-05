/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  Context,
  InvocationContext,
  LoadSkillTool,
  PluginManager,
  Skill,
  SkillToolset,
  createSession,
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

  it('refuses to record an activation for an invocation with no agent', async () => {
    // This tool is the only writer of `_adk_activated_skill_<agentName>`, and
    // it derives the name through requireAgent. SkillToolset reads the same
    // key via ReadonlyContext.agentName, whose 'unknown' sentinel would
    // otherwise merge every agentless invocation into one bucket. Because the
    // write throws first, no `_unknown` bucket can exist to be read back.
    const toolset = new SkillToolset([mockSkill]);
    const tool = new LoadSkillTool(toolset);
    const toolContext = new Context({
      invocationContext: new InvocationContext({
        invocationId: 'inv-1',
        session: createSession({
          id: 'test-session',
          appName: 'test-app',
          userId: 'test-user',
        }),
        pluginManager: new PluginManager(),
      }),
    });

    await expect(
      tool.runAsync({args: {name: 'test-skill'}, toolContext}),
    ).rejects.toThrow(/agent is not set/);

    expect(
      toolContext.state.get('_adk_activated_skill_unknown'),
    ).toBeUndefined();
  });
});
