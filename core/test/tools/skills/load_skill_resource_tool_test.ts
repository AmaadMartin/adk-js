/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {describe, expect, it} from 'vitest';
import type {InvocationContext, LlmRequest, Skill} from '../../../src/index.js';
import {
  Context,
  LoadSkillResourceErrorCode,
  LoadSkillResourceTool,
  SkillToolset,
} from '../../../src/index.js';

/** Shape of the error response `runAsync` returns when a call fails. */
interface ToolErrorResponse {
  error: string;
  error_code: LoadSkillResourceErrorCode;
}

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

  function createMockContext(
    agentName = 'test-agent',
    invocationId = 'inv-1',
    sessionState: Record<string, unknown> = {},
  ) {
    return new Context({
      invocationContext: {
        invocationId,
        session: {state: sessionState},
        agent: {name: agentName},
      } as unknown as InvocationContext,
    });
  }

  it('loads text resource', async () => {
    const toolset = new SkillToolset([mockSkill]);
    const tool = new LoadSkillResourceTool(toolset);
    const result = await tool.runAsync({
      args: {skill_name: 'test-skill', file_path: 'references/doc.md'},
      toolContext: createMockContext(),
    });
    expect(result).toEqual({
      skill_name: 'test-skill',
      file_path: 'references/doc.md',
      content: 'Doc content',
    });
  });

  it('loads script resource', async () => {
    const toolset = new SkillToolset([mockSkill]);
    const tool = new LoadSkillResourceTool(toolset);
    const result = await tool.runAsync({
      args: {skill_name: 'test-skill', file_path: 'scripts/run.sh'},
      toolContext: createMockContext(),
    });
    expect(result).toEqual({
      skill_name: 'test-skill',
      file_path: 'scripts/run.sh',
      content: 'echo hello',
    });
  });

  it('handles binary files by returning status', async () => {
    const toolset = new SkillToolset([mockSkill]);
    const tool = new LoadSkillResourceTool(toolset);
    const result = await tool.runAsync({
      args: {skill_name: 'test-skill', file_path: 'assets/image.png'},
      toolContext: createMockContext(),
    });
    expect(result).toEqual({
      skill_name: 'test-skill',
      file_path: 'assets/image.png',
      status:
        'Binary file detected. The content has been injected into the conversation history for you to analyze.',
    });
  });

  it('returns error on invalid path', async () => {
    const toolset = new SkillToolset([mockSkill]);
    const tool = new LoadSkillResourceTool(toolset);
    const result = await tool.runAsync({
      args: {skill_name: 'test-skill', file_path: 'invalid/path.md'},
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
      args: {skill_name: 'test-skill', file_path: 'references/nonexistent.md'},
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
        file_path: 'references/../references/doc.md',
      },
      toolContext: createMockContext(),
    });
    expect(result).toEqual({
      skill_name: 'test-skill',
      file_path: 'references/doc.md',
      content: 'Doc content',
    });
  });

  it('handles traversing from one resource folder to another via /../', async () => {
    const toolset = new SkillToolset([mockSkill]);
    const tool = new LoadSkillResourceTool(toolset);
    const result = await tool.runAsync({
      args: {
        skill_name: 'test-skill',
        file_path: 'references/../assets/image.png',
      },
      toolContext: createMockContext(),
    });
    expect(result).toEqual({
      skill_name: 'test-skill',
      file_path: 'assets/image.png',
      status:
        'Binary file detected. The content has been injected into the conversation history for you to analyze.',
    });
  });

  it('blocks traversing completely outside resource directories via /../', async () => {
    const toolset = new SkillToolset([mockSkill]);
    const tool = new LoadSkillResourceTool(toolset);
    const result = await tool.runAsync({
      args: {
        skill_name: 'test-skill',
        file_path: 'references/../../secrets.txt',
      },
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
                  file_path: 'assets/image.png',
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
                  file_path: 'assets/file.unknown',
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

  it('declares file_path as the resource argument', () => {
    const toolset = new SkillToolset([mockSkill]);
    const tool = new LoadSkillResourceTool(toolset);

    const parameters = tool._getDeclaration().parameters;

    expect(parameters?.properties).toHaveProperty('file_path');
    expect(parameters?.properties).not.toHaveProperty('path');
    expect(parameters?.required).toEqual(['skill_name', 'file_path']);
  });

  it('rejects the legacy path argument', async () => {
    const toolset = new SkillToolset([mockSkill]);
    const tool = new LoadSkillResourceTool(toolset);
    const result = await tool.runAsync({
      args: {skill_name: 'test-skill', path: 'references/doc.md'},
      toolContext: createMockContext(),
    });
    expect(result).toEqual({
      error: "Argument 'file_path' is required.",
      error_code: LoadSkillResourceErrorCode.MISSING_RESOURCE_PATH,
    });
  });

  function binaryFunctionResponse(
    response: Record<string, unknown>,
  ): LlmRequest {
    return {
      contents: [
        {
          role: 'user',
          parts: [
            {
              functionResponse: {
                name: 'load_skill_resource',
                response: {
                  ...response,
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
  }

  it('ignores a legacy path key in processLlmRequest', async () => {
    const toolset = new SkillToolset([mockSkill]);
    const tool = new LoadSkillResourceTool(toolset);
    const llmRequest = binaryFunctionResponse({
      skill_name: 'test-skill',
      path: 'assets/image.png',
    });

    await tool.processLlmRequest({
      toolContext: createMockContext(),
      llmRequest,
    });

    expect(llmRequest.contents.length).toBe(1);
  });

  it('ignores a response without a skill_name in processLlmRequest', async () => {
    const toolset = new SkillToolset([mockSkill]);
    const tool = new LoadSkillResourceTool(toolset);
    const llmRequest = binaryFunctionResponse({
      file_path: 'assets/image.png',
    });

    await tool.processLlmRequest({
      toolContext: createMockContext(),
      llmRequest,
    });

    expect(llmRequest.contents.length).toBe(1);
  });

  describe('error codes', () => {
    it('exposes stable string values for the error-code enum', () => {
      // The error-code string values are part of the tool's response contract
      // and must remain stable across releases.
      expect(LoadSkillResourceErrorCode.MISSING_SKILL_NAME).toBe(
        'MISSING_SKILL_NAME',
      );
      expect(LoadSkillResourceErrorCode.MISSING_RESOURCE_PATH).toBe(
        'MISSING_RESOURCE_PATH',
      );
      expect(LoadSkillResourceErrorCode.REGISTRY_ERROR).toBe('REGISTRY_ERROR');
      expect(LoadSkillResourceErrorCode.SKILL_NOT_FOUND).toBe(
        'SKILL_NOT_FOUND',
      );
      expect(LoadSkillResourceErrorCode.INVALID_RESOURCE_PATH).toBe(
        'INVALID_RESOURCE_PATH',
      );
      expect(LoadSkillResourceErrorCode.RESOURCE_NOT_FOUND).toBe(
        'RESOURCE_NOT_FOUND',
      );
      expect(LoadSkillResourceErrorCode.RESOURCE_NOT_FOUND_FATAL).toBe(
        'RESOURCE_NOT_FOUND_FATAL',
      );
    });
  });

  it('escalates to RESOURCE_NOT_FOUND_FATAL on the second miss in the same invocation', async () => {
    const toolset = new SkillToolset([mockSkill]);
    const tool = new LoadSkillResourceTool(toolset);
    const toolContext = createMockContext();
    const args = {
      skill_name: 'test-skill',
      file_path: 'references/nonexistent.md',
    };

    expect(await tool.runAsync({args, toolContext})).toEqual({
      error:
        "Resource 'references/nonexistent.md' not found in skill 'test-skill'.",
      error_code: LoadSkillResourceErrorCode.RESOURCE_NOT_FOUND,
    });
    expect(await tool.runAsync({args, toolContext})).toEqual({
      error:
        "Resource 'references/nonexistent.md' not found in skill 'test-skill'." +
        ' This is resource lookup failure #2 this invocation. Do not retry any' +
        ' path — report the error to the user and stop.',
      error_code: LoadSkillResourceErrorCode.RESOURCE_NOT_FOUND_FATAL,
    });
  });

  it('escalates even when the second miss uses a different resource path', async () => {
    const toolset = new SkillToolset([mockSkill]);
    const tool = new LoadSkillResourceTool(toolset);
    const toolContext = createMockContext();

    const first = (await tool.runAsync({
      args: {skill_name: 'test-skill', file_path: 'references/missing-a.md'},
      toolContext,
    })) as ToolErrorResponse;
    expect(first.error_code).toBe(
      LoadSkillResourceErrorCode.RESOURCE_NOT_FOUND,
    );

    expect(
      await tool.runAsync({
        args: {skill_name: 'test-skill', file_path: 'references/missing-b.md'},
        toolContext,
      }),
    ).toEqual({
      error:
        "Resource 'references/missing-b.md' not found in skill 'test-skill'." +
        ' This is resource lookup failure #2 this invocation. Do not retry any' +
        ' path — report the error to the user and stop.',
      error_code: LoadSkillResourceErrorCode.RESOURCE_NOT_FOUND_FATAL,
    });
  });

  it('keeps counting misses across references/, assets/ and scripts/ prefixes', async () => {
    const toolset = new SkillToolset([mockSkill]);
    const tool = new LoadSkillResourceTool(toolset);
    const toolContext = createMockContext();
    const paths = ['references/nope.md', 'assets/nope.png', 'scripts/nope.sh'];

    const results: ToolErrorResponse[] = [];
    for (const path of paths) {
      results.push(
        (await tool.runAsync({
          args: {skill_name: 'test-skill', file_path: path},
          toolContext,
        })) as ToolErrorResponse,
      );
    }

    expect(results.map((r) => r.error_code)).toEqual([
      LoadSkillResourceErrorCode.RESOURCE_NOT_FOUND,
      LoadSkillResourceErrorCode.RESOURCE_NOT_FOUND_FATAL,
      LoadSkillResourceErrorCode.RESOURCE_NOT_FOUND_FATAL,
    ]);
    expect(results[1].error).toContain('failure #2');
    expect(results[2].error).toContain('failure #3');
  });

  it('resets the counter for a new invocation id', async () => {
    const toolset = new SkillToolset([mockSkill]);
    const tool = new LoadSkillResourceTool(toolset);
    const sharedState: Record<string, unknown> = {};
    const args = {skill_name: 'test-skill', file_path: 'references/typo.md'};
    const first = createMockContext('test-agent', 'inv-1', sharedState);
    const second = createMockContext('test-agent', 'inv-2', sharedState);

    const codes: LoadSkillResourceErrorCode[] = [];
    for (const toolContext of [first, first, second]) {
      const result = (await tool.runAsync({
        args,
        toolContext,
      })) as ToolErrorResponse;
      codes.push(result.error_code);
    }

    expect(codes).toEqual([
      LoadSkillResourceErrorCode.RESOURCE_NOT_FOUND,
      LoadSkillResourceErrorCode.RESOURCE_NOT_FOUND_FATAL,
      LoadSkillResourceErrorCode.RESOURCE_NOT_FOUND,
    ]);
    expect(sharedState).toEqual({
      'temp:_adk_skill_resource_not_found_count_inv-1': 2,
      'temp:_adk_skill_resource_not_found_count_inv-2': 1,
    });
  });
});
