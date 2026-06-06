/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  Context,
  InvocationContext,
  LlmRequest,
  LoadSkillResourceTool,
  Skill,
  SkillToolset,
} from '@google/adk';
import {describe, expect, it, vi} from 'vitest';

describe('LoadSkillResourceTool', () => {
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

  it('loads text resource', async () => {
    const toolset = new SkillToolset([mockSkill]);
    const tool = new LoadSkillResourceTool(toolset);
    const result = await tool.runAsync({
      args: {skill_name: 'test-skill', path: 'references/doc.md'},
      toolContext: createMockContext(),
    });
    expect(result).toEqual({
      skill_name: 'test-skill',
      path: 'references/doc.md',
      content: 'Doc content',
    });
  });

  it('loads script resource', async () => {
    const toolset = new SkillToolset([mockSkill]);
    const tool = new LoadSkillResourceTool(toolset);
    const result = await tool.runAsync({
      args: {skill_name: 'test-skill', path: 'scripts/run.sh'},
      toolContext: createMockContext(),
    });
    expect(result).toEqual({
      skill_name: 'test-skill',
      path: 'scripts/run.sh',
      content: 'echo hello',
    });
  });

  it('handles binary files by returning status', async () => {
    const toolset = new SkillToolset([mockSkill]);
    const tool = new LoadSkillResourceTool(toolset);
    const result = await tool.runAsync({
      args: {skill_name: 'test-skill', path: 'assets/image.png'},
      toolContext: createMockContext(),
    });
    expect(result).toEqual({
      skill_name: 'test-skill',
      path: 'assets/image.png',
      status:
        'Binary file detected. The content has been injected into the conversation history for you to analyze.',
    });
  });

  it('returns error on invalid path', async () => {
    const toolset = new SkillToolset([mockSkill]);
    const tool = new LoadSkillResourceTool(toolset);
    const result = await tool.runAsync({
      args: {skill_name: 'test-skill', path: 'invalid/path.md'},
      toolContext: createMockContext(),
    });
    expect(result).toEqual({
      error: "Path must start with 'references/', 'assets/', or 'scripts/'.",
      error_code: 'INVALID_RESOURCE_PATH',
    });
  });

  it('returns error if resource not found', async () => {
    const toolset = new SkillToolset([mockSkill]);
    const tool = new LoadSkillResourceTool(toolset);
    const result = await tool.runAsync({
      args: {skill_name: 'test-skill', path: 'references/nonexistent.md'},
      toolContext: createMockContext(),
    });
    expect(result).toEqual({
      error:
        "Resource 'references/nonexistent.md' not found in skill 'test-skill'.",
      error_code: 'RESOURCE_NOT_FOUND',
    });
  });

  it('handles /../ in paths correctly to resolve resources', async () => {
    const toolset = new SkillToolset([mockSkill]);
    const tool = new LoadSkillResourceTool(toolset);
    const result = await tool.runAsync({
      args: {
        skill_name: 'test-skill',
        path: 'references/../references/doc.md',
      },
      toolContext: createMockContext(),
    });
    expect(result).toEqual({
      skill_name: 'test-skill',
      path: 'references/doc.md',
      content: 'Doc content',
    });
  });

  it('handles traversing from one resource folder to another via /../', async () => {
    const toolset = new SkillToolset([mockSkill]);
    const tool = new LoadSkillResourceTool(toolset);
    const result = await tool.runAsync({
      args: {
        skill_name: 'test-skill',
        path: 'references/../assets/image.png',
      },
      toolContext: createMockContext(),
    });
    expect(result).toEqual({
      skill_name: 'test-skill',
      path: 'assets/image.png',
      status:
        'Binary file detected. The content has been injected into the conversation history for you to analyze.',
    });
  });

  it('blocks traversing completely outside resource directories via /../', async () => {
    const toolset = new SkillToolset([mockSkill]);
    const tool = new LoadSkillResourceTool(toolset);
    const result = await tool.runAsync({
      args: {skill_name: 'test-skill', path: 'references/../../secrets.txt'},
      toolContext: createMockContext(),
    });
    expect(result).toEqual({
      error: "Path must start with 'references/', 'assets/', or 'scripts/'.",
      error_code: 'INVALID_RESOURCE_PATH',
    });
  });

  it('injects binary content in processLlmRequest', async () => {
    const toolset = new SkillToolset([mockSkill]);
    const tool = new LoadSkillResourceTool(toolset);

    const llmRequest: LlmRequest = {
      contents: [
        {
          role: 'user',
          parts: [
            {
              functionResponse: {
                name: 'load_skill_resource',
                response: {
                  skill_name: 'test-skill',
                  path: 'assets/image.png',
                  status:
                    'Binary file detected. The content has been injected into the conversation history for you to analyze.',
                },
              },
            },
          ],
        },
      ],
      toolsDict: {},
      liveConnectConfig: {},
    };

    await tool.processLlmRequest({
      toolContext: createMockContext(),
      llmRequest,
    });

    expect(llmRequest.contents.length).toBe(2);
    expect(llmRequest.contents[1].role).toBe('user');
    expect(llmRequest.contents[1].parts?.[1]?.inlineData?.data).toBe(
      Buffer.from('fake image data').toString('base64'),
    );
    expect(llmRequest.contents[1]?.parts?.[1].inlineData?.mimeType).toBe(
      'image/png',
    );
  });

  it('uses default mime type for unknown extension in processLlmRequest', async () => {
    const mockSkillWithUnknownExt: Skill = {
      frontmatter: {name: 'test-skill', description: 'desc'},
      instructions: 'inst',
      resources: {
        assets: {
          'file.unknown': Buffer.from('data'),
        },
      },
    };
    const toolset = new SkillToolset([mockSkillWithUnknownExt]);
    const tool = new LoadSkillResourceTool(toolset);

    const llmRequest: LlmRequest = {
      contents: [
        {
          role: 'user',
          parts: [
            {
              functionResponse: {
                name: 'load_skill_resource',
                response: {
                  skill_name: 'test-skill',
                  path: 'assets/file.unknown',
                  status:
                    'Binary file detected. The content has been injected into the conversation history for you to analyze.',
                },
              },
            },
          ],
        },
      ],
      toolsDict: {},
      liveConnectConfig: {},
    };

    await tool.processLlmRequest({
      toolContext: createMockContext(),
      llmRequest,
    });

    expect(llmRequest.contents[1]?.parts?.[1]?.inlineData?.mimeType).toBe(
      'application/octet-stream',
    );
  });

  it('returns error if skill_name or path is missing', async () => {
    const toolset = new SkillToolset([mockSkill]);
    const tool = new LoadSkillResourceTool(toolset);

    const res1 = await tool.runAsync({
      args: {skill_name: '', path: 'references/doc.md'},
      toolContext: createMockContext(),
    });
    expect(res1).toEqual({
      error: 'Skill name is required.',
      error_code: 'MISSING_SKILL_NAME',
    });

    const res2 = await tool.runAsync({
      args: {skill_name: 'test-skill', path: ''},
      toolContext: createMockContext(),
    });
    expect(res2).toEqual({
      error: 'Resource path is required.',
      error_code: 'MISSING_RESOURCE_PATH',
    });
  });

  it('returns error on registry fetch failure', async () => {
    const toolset = new SkillToolset([]);
    vi.spyOn(toolset, 'getOrFetchSkill').mockRejectedValue(
      new Error('Registry connection error'),
    );

    const tool = new LoadSkillResourceTool(toolset);
    const result = await tool.runAsync({
      args: {skill_name: 'test-skill', path: 'references/doc.md'},
      toolContext: createMockContext(),
    });
    expect(result).toEqual({
      error:
        "Failed to fetch skill 'test-skill' from registry: Error: Registry connection error",
      error_code: 'REGISTRY_ERROR',
    });
  });

  it('skips binary injection in processLlmRequest if skill is not found', async () => {
    const toolset = new SkillToolset([]);
    vi.spyOn(toolset, 'getOrFetchSkill').mockResolvedValue(undefined);
    const tool = new LoadSkillResourceTool(toolset);

    const llmRequest: LlmRequest = {
      contents: [
        {
          role: 'user',
          parts: [
            {
              functionResponse: {
                name: 'load_skill_resource',
                response: {
                  skill_name: 'nonexistent-skill',
                  path: 'assets/image.png',
                  status:
                    'Binary file detected. The content has been injected into the conversation history for you to analyze.',
                },
              },
            },
          ],
        },
      ],
      toolsDict: {},
      liveConnectConfig: {},
    };

    await tool.processLlmRequest({
      toolContext: createMockContext(),
      llmRequest,
    });

    expect(llmRequest.contents.length).toBe(1);
  });

  it('handles missing resources in processLlmRequest gracefully', async () => {
    const mockSkillNoResources: Skill = {
      frontmatter: {name: 'test-skill', description: 'desc'},
      instructions: 'inst',
    };
    const toolset = new SkillToolset([mockSkillNoResources]);
    const tool = new LoadSkillResourceTool(toolset);

    const llmRequest: LlmRequest = {
      contents: [
        {
          role: 'user',
          parts: [
            {
              functionResponse: {
                name: 'load_skill_resource',
                response: {
                  skill_name: 'test-skill',
                  path: 'assets/file.png',
                  status:
                    'Binary file detected. The content has been injected into the conversation history for you to analyze.',
                },
              },
            },
          ],
        },
      ],
      toolsDict: {},
      liveConnectConfig: {},
    };

    await tool.processLlmRequest({
      toolContext: createMockContext(),
      llmRequest,
    });

    expect(llmRequest.contents.length).toBe(1);
  });
});
