/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Context, ListSkillsTool, Skill, SkillToolset} from '@google/adk';
import {describe, expect, it} from 'vitest';
import {createInvocationContext} from '../../testing_utils.js';

describe('ListSkillsTool', () => {
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
      invocationContext: createInvocationContext({agentName}),
    });
  }

  it('lists available skills', async () => {
    const toolset = new SkillToolset([mockSkill]);
    const tool = new ListSkillsTool(toolset);
    const result = await tool.runAsync({
      args: {},
      toolContext: createMockContext(),
    });
    expect(result).toContain('<name>test-skill</name>');
  });
});
