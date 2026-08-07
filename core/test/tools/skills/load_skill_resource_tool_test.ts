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
import {describe, expect, it} from 'vitest';

describe('LoadSkillResourceTool', () => {
  const BINARY_ASSET = Buffer.from('fake image data');
  const BINARY_FILE_DETECTED_MSG =
    'Binary file detected. The content has been injected into the conversation history for you to analyze.';
  const DECLINED_STATUS =
    'Binary file detected, but it was not injected into the conversation ' +
    'history: it is 15 bytes, which exceeds the 10 byte limit for inline ' +
    'skill resources. Do not retry; process the file with a skill script ' +
    'instead.';

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
        'image.png': BINARY_ASSET,
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

  function createLlmRequestWithResponse(
    response: Record<string, unknown>,
  ): LlmRequest {
    return {
      contents: [
        {
          role: 'user',
          parts: [{functionResponse: {name: 'load_skill_resource', response}}],
        },
      ],
      toolsDict: {},
      liveConnectConfig: {},
    };
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

  it('injects a binary resource at exactly the configured limit', async () => {
    const toolset = new SkillToolset([mockSkill], {
      maxInlineResourceBytes: BINARY_ASSET.byteLength,
    });
    const tool = new LoadSkillResourceTool(toolset);

    const expectedResponse = {
      skill_name: 'test-skill',
      path: 'assets/image.png',
      status: BINARY_FILE_DETECTED_MSG,
    };
    const result = await tool.runAsync({
      args: {skill_name: 'test-skill', path: 'assets/image.png'},
      toolContext: createMockContext(),
    });
    expect(result).toEqual(expectedResponse);

    const llmRequest = createLlmRequestWithResponse(expectedResponse);
    await tool.processLlmRequest({
      toolContext: createMockContext(),
      llmRequest,
    });

    expect(llmRequest.contents.length).toBe(2);
    expect(llmRequest.contents[1].parts?.[1]?.inlineData?.data).toBe(
      BINARY_ASSET.toString('base64'),
    );
  });

  it('declines a binary resource over the configured limit', async () => {
    const toolset = new SkillToolset([mockSkill], {maxInlineResourceBytes: 10});
    const tool = new LoadSkillResourceTool(toolset);

    const result = await tool.runAsync({
      args: {skill_name: 'test-skill', path: 'assets/image.png'},
      toolContext: createMockContext(),
    });

    expect(result).toEqual({
      skill_name: 'test-skill',
      path: 'assets/image.png',
      status: DECLINED_STATUS,
    });
  });

  it('does not inject a declined binary resource', async () => {
    const toolset = new SkillToolset([mockSkill], {maxInlineResourceBytes: 10});
    const tool = new LoadSkillResourceTool(toolset);

    const declinedResponse = {
      skill_name: 'test-skill',
      path: 'assets/image.png',
      status: DECLINED_STATUS,
    };
    const result = await tool.runAsync({
      args: {skill_name: 'test-skill', path: 'assets/image.png'},
      toolContext: createMockContext(),
    });
    expect(result).toEqual(declinedResponse);
    const llmRequest = createLlmRequestWithResponse(declinedResponse);

    await tool.processLlmRequest({
      toolContext: createMockContext(),
      llmRequest,
    });

    expect(llmRequest.contents.length).toBe(1);
  });

  it('does not inject an oversized resource recorded under a higher limit', async () => {
    const toolset = new SkillToolset([mockSkill], {maxInlineResourceBytes: 10});
    const tool = new LoadSkillResourceTool(toolset);

    const llmRequest = createLlmRequestWithResponse({
      skill_name: 'test-skill',
      path: 'assets/image.png',
      status: BINARY_FILE_DETECTED_MSG,
    });

    await tool.processLlmRequest({
      toolContext: createMockContext(),
      llmRequest,
    });

    expect(llmRequest.contents.length).toBe(1);
  });

  it('declines an oversized binary reference, not just an asset', async () => {
    const skillWithBinaryReference: Skill = {
      frontmatter: {name: 'binary-ref-skill', description: 'desc'},
      instructions: 'inst',
      resources: {
        references: {
          'diagram.png': BINARY_ASSET,
        },
      },
    };
    const toolset = new SkillToolset([skillWithBinaryReference], {
      maxInlineResourceBytes: 1,
    });
    const tool = new LoadSkillResourceTool(toolset);

    const result = await tool.runAsync({
      args: {skill_name: 'binary-ref-skill', path: 'references/diagram.png'},
      toolContext: createMockContext(),
    });

    expect(result).toEqual({
      skill_name: 'binary-ref-skill',
      path: 'references/diagram.png',
      status:
        'Binary file detected, but it was not injected into the conversation ' +
        'history: it is 15 bytes, which exceeds the 1 byte limit for inline ' +
        'skill resources. Do not retry; process the file with a skill script ' +
        'instead.',
    });
  });

  it('does not apply the byte limit to text resources', async () => {
    const longText = 'x'.repeat(1000);
    const textSkill: Skill = {
      frontmatter: {name: 'text-skill', description: 'desc'},
      instructions: 'inst',
      resources: {
        references: {'doc.md': longText},
        scripts: {'run.sh': {src: longText}},
      },
    };
    const toolset = new SkillToolset([textSkill], {maxInlineResourceBytes: 1});
    const tool = new LoadSkillResourceTool(toolset);

    const reference = await tool.runAsync({
      args: {skill_name: 'text-skill', path: 'references/doc.md'},
      toolContext: createMockContext(),
    });
    const script = await tool.runAsync({
      args: {skill_name: 'text-skill', path: 'scripts/run.sh'},
      toolContext: createMockContext(),
    });

    expect(reference).toEqual({
      skill_name: 'text-skill',
      path: 'references/doc.md',
      content: longText,
    });
    expect(script).toEqual({
      skill_name: 'text-skill',
      path: 'scripts/run.sh',
      content: longText,
    });
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
});
