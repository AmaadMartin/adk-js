/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  BaseCodeExecutor,
  CodeExecutionLanguage,
  CodeExecutionResult,
  Context,
  ExecuteCodeParams,
  File,
  FileContentEncoding,
  InvocationContext,
  LlmAgent,
  RunSkillInlineScriptErrorCode,
  RunSkillInlineScriptTool,
  SessionArtifactService,
  SkillToolset,
} from '@google/adk';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {InMemoryArtifactService} from '../../../src/artifacts/in_memory_artifact_service.js';
import {ScopedArtifactService} from '../../../src/artifacts/scoped_artifact_service.js';
import {ToolConfirmation} from '../../../src/tools/tool_confirmation.js';
import {materializeFiles} from '../../../src/utils/file_utils.js';
import {logger} from '../../../src/utils/logger.js';

vi.mock('../../../src/utils/file_utils.js', () => ({
  materializeFiles: vi.fn().mockImplementation((files) => files),
}));

class MockCodeExecutor extends BaseCodeExecutor {
  mockResult: CodeExecutionResult = {
    stdout: '',
    stderr: '',
    outputFiles: [],
  };
  executeCodeParams: ExecuteCodeParams | undefined;
  shouldThrow = false;

  override async executeCode(
    params: ExecuteCodeParams,
  ): Promise<CodeExecutionResult> {
    this.executeCodeParams = params;
    if (this.shouldThrow) {
      throw new Error('Mock execution failure');
    }
    return this.mockResult;
  }
}

interface ToolErrorResponse {
  error: string;
  errorCode: RunSkillInlineScriptErrorCode;
}

/** The tool result once artifact persistence has augmented it. */
type ArtifactAugmentedResult = CodeExecutionResult & {
  savedArtifacts: Record<string, number>;
};

describe('RunSkillInlineScriptTool', () => {
  function createMockContext(
    agentName = 'test-agent',
    agentExecutor?: BaseCodeExecutor,
    options: {
      functionCallId?: string;
      toolConfirmation?: ToolConfirmation;
      artifactService?: SessionArtifactService;
    } = {},
  ): Context {
    const agentObj: Record<string | symbol, unknown> = {name: agentName};
    if (agentExecutor) {
      agentObj['codeExecutor'] = agentExecutor;
      agentObj[Symbol.for('google.adk.llmAgent')] = true;
    }

    return new Context({
      invocationContext: {
        session: {state: {}},
        agent: agentObj as unknown as LlmAgent,
        artifactService: options.artifactService,
      } as unknown as InvocationContext,
      functionCallId: options.functionCallId,
      toolConfirmation: options.toolConfirmation,
    });
  }

  /**
   * A confirmed confirmation lets execution proceed past the security gate.
   */
  function confirmed(): ToolConfirmation {
    return new ToolConfirmation({confirmed: true});
  }

  it('returns error if script content is missing', async () => {
    const toolset = new SkillToolset([]);
    const tool = new RunSkillInlineScriptTool(toolset);
    const result = (await tool.runAsync({
      args: {language: CodeExecutionLanguage.JAVASCRIPT},
      toolContext: createMockContext(),
    })) as ToolErrorResponse;

    expect(result).toEqual({
      error: 'Script content is required.',
      errorCode: RunSkillInlineScriptErrorCode.MISSING_SCRIPT_CONTENT,
    });
  });

  it('returns error if language is missing', async () => {
    const toolset = new SkillToolset([]);
    const tool = new RunSkillInlineScriptTool(toolset);
    const result = (await tool.runAsync({
      args: {script_content: 'console.log("test");'},
      toolContext: createMockContext(),
    })) as ToolErrorResponse;

    expect(result).toEqual({
      error: 'Language is required.',
      errorCode: RunSkillInlineScriptErrorCode.MISSING_LANGUAGE,
    });
  });

  it('returns error if no code executor configured', async () => {
    const toolset = new SkillToolset([]); // no executor
    const tool = new RunSkillInlineScriptTool(toolset);
    const result = (await tool.runAsync({
      args: {
        script_content: 'console.log("test");',
        language: CodeExecutionLanguage.JAVASCRIPT,
      },
      toolContext: createMockContext(),
    })) as ToolErrorResponse;

    expect(result).toEqual({
      error: 'No code executor configured.',
      errorCode: RunSkillInlineScriptErrorCode.NO_CODE_EXECUTOR,
    });
  });

  it('falls back to agent code executor when toolset executor is absent', async () => {
    const agentExecutor = new MockCodeExecutor();
    agentExecutor.mockResult = {
      stdout: 'agent fallback stdout',
      stderr: '',
      outputFiles: [],
    };

    const toolset = new SkillToolset([]); // no executor
    const tool = new RunSkillInlineScriptTool(toolset);

    const result = (await tool.runAsync({
      args: {
        script_content: 'console.log("agent");',
        language: CodeExecutionLanguage.JAVASCRIPT,
      },
      toolContext: createMockContext('agent-with-exec', agentExecutor, {
        toolConfirmation: confirmed(),
      }),
    })) as CodeExecutionResult;

    expect(result.stdout).toBe('agent fallback stdout');
    expect(agentExecutor.executeCodeParams?.codeExecutionInput.code).toBe(
      'console.log("agent");',
    );
  });

  it('returns execution error when executor throws', async () => {
    const mockExecutor = new MockCodeExecutor();
    mockExecutor.shouldThrow = true;

    const toolset = new SkillToolset([], {codeExecutor: mockExecutor});
    const tool = new RunSkillInlineScriptTool(toolset);

    const result = (await tool.runAsync({
      args: {
        script_content: 'console.log("error");',
        language: CodeExecutionLanguage.PYTHON,
      },
      toolContext: createMockContext('test-agent', undefined, {
        toolConfirmation: confirmed(),
      }),
    })) as ToolErrorResponse;

    expect(result).toEqual({
      error: 'Failed to execute inline script: Mock execution failure',
      errorCode: RunSkillInlineScriptErrorCode.EXECUTION_ERROR,
    });
  });

  it('successfully passes parameters to code executor', async () => {
    const mockExecutor = new MockCodeExecutor();
    mockExecutor.mockResult = {
      stdout: 'mock output',
      stderr: 'mock warning',
      outputFiles: [],
    };

    const toolset = new SkillToolset([], {codeExecutor: mockExecutor});
    const tool = new RunSkillInlineScriptTool(toolset);

    const mockToolContext = createMockContext('test-agent', undefined, {
      toolConfirmation: confirmed(),
    });

    const result = (await tool.runAsync({
      args: {
        script_content: 'echo "hi"',
        language: CodeExecutionLanguage.SHELL,
        args: {flag: true, count: 5},
      },
      toolContext: mockToolContext,
    })) as CodeExecutionResult;

    expect(result).toEqual({
      stdout: 'mock output',
      stderr: 'mock warning',
      outputFiles: [],
    });

    expect(mockExecutor.executeCodeParams).toBeDefined();
    expect(mockExecutor.executeCodeParams?.invocationContext).toBe(
      mockToolContext.invocationContext,
    );
    expect(mockExecutor.executeCodeParams?.codeExecutionInput).toEqual({
      code: 'echo "hi"',
      inputFiles: [],
      language: CodeExecutionLanguage.SHELL,
      args: {flag: true, count: 5},
    });
  });

  it('calls materializeFiles with output files from executor', async () => {
    const mockExecutor = new MockCodeExecutor();
    const testFile: File = {
      name: 'output.txt',
      content: 'hello',
      contentEncoding: FileContentEncoding.UTF8,
      mimeType: 'text/plain',
    };
    mockExecutor.mockResult = {
      stdout: '',
      stderr: '',
      outputFiles: [testFile],
    };

    const toolset = new SkillToolset([], {codeExecutor: mockExecutor});
    const tool = new RunSkillInlineScriptTool(toolset);

    await tool.runAsync({
      args: {
        script_content: 'console.log("test");',
        language: CodeExecutionLanguage.JAVASCRIPT,
      },
      toolContext: createMockContext('test-agent', undefined, {
        toolConfirmation: confirmed(),
      }),
    });

    expect(materializeFiles).toHaveBeenCalledWith([testFile]);
  });

  it('successfully passes array arguments to code executor', async () => {
    const mockExecutor = new MockCodeExecutor();
    mockExecutor.mockResult = {
      stdout: 'mock output',
      stderr: '',
      outputFiles: [],
    };

    const toolset = new SkillToolset([], {codeExecutor: mockExecutor});
    const tool = new RunSkillInlineScriptTool(toolset);

    const mockToolContext = createMockContext('test-agent', undefined, {
      toolConfirmation: confirmed(),
    });

    await tool.runAsync({
      args: {
        script_content: 'echo "hi"',
        language: CodeExecutionLanguage.SHELL,
        args: ['arg1', 'arg2'],
      },
      toolContext: mockToolContext,
    });

    expect(mockExecutor.executeCodeParams?.codeExecutionInput.args).toEqual([
      'arg1',
      'arg2',
    ]);
  });

  describe('confirmation gate', () => {
    it('blocks execution and requests confirmation on the first call', async () => {
      const mockExecutor = new MockCodeExecutor();
      const toolset = new SkillToolset([], {codeExecutor: mockExecutor});
      const tool = new RunSkillInlineScriptTool(toolset);

      // No toolConfirmation provided -> the tool must pause and request one.
      const mockToolContext = createMockContext('test-agent', undefined, {
        functionCallId: 'fc-1',
      });

      const result = (await tool.runAsync({
        args: {
          script_content: 'rm -rf /',
          language: CodeExecutionLanguage.SHELL,
        },
        toolContext: mockToolContext,
      })) as {partial: string};

      // Execution must NOT have happened.
      expect(mockExecutor.executeCodeParams).toBeUndefined();

      // An intermediate "needs confirmation" result is returned.
      expect(result).toEqual({
        partial:
          'This tool call needs external confirmation before completion.',
      });

      // A confirmation request was recorded against the function call id and
      // it surfaces the script + language to the client.
      const requested =
        mockToolContext.actions.requestedToolConfirmations['fc-1'];
      expect(requested).toBeDefined();
      expect(requested.confirmed).toBe(false);
      expect(requested.hint).toContain('rm -rf /');
      expect(requested.hint).toContain(CodeExecutionLanguage.SHELL);
      expect(requested.payload).toEqual({
        language: CodeExecutionLanguage.SHELL,
        scriptContent: 'rm -rf /',
      });
    });

    it('rejects execution when confirmation is not confirmed', async () => {
      const mockExecutor = new MockCodeExecutor();
      const toolset = new SkillToolset([], {codeExecutor: mockExecutor});
      const tool = new RunSkillInlineScriptTool(toolset);

      const mockToolContext = createMockContext('test-agent', undefined, {
        functionCallId: 'fc-2',
        toolConfirmation: new ToolConfirmation({confirmed: false}),
      });

      const result = (await tool.runAsync({
        args: {
          script_content: 'console.log("nope");',
          language: CodeExecutionLanguage.JAVASCRIPT,
        },
        toolContext: mockToolContext,
      })) as ToolErrorResponse;

      // Execution must NOT have happened.
      expect(mockExecutor.executeCodeParams).toBeUndefined();
      expect(result).toEqual({
        error: 'Inline script execution was not confirmed and was rejected.',
        errorCode: RunSkillInlineScriptErrorCode.CONFIRMATION_REJECTED,
      });
    });

    it('proceeds with execution once confirmed', async () => {
      const mockExecutor = new MockCodeExecutor();
      mockExecutor.mockResult = {
        stdout: 'confirmed output',
        stderr: '',
        outputFiles: [],
      };
      const toolset = new SkillToolset([], {codeExecutor: mockExecutor});
      const tool = new RunSkillInlineScriptTool(toolset);

      const mockToolContext = createMockContext('test-agent', undefined, {
        functionCallId: 'fc-3',
        toolConfirmation: new ToolConfirmation({confirmed: true}),
      });

      const result = (await tool.runAsync({
        args: {
          script_content: 'console.log("go");',
          language: CodeExecutionLanguage.JAVASCRIPT,
        },
        toolContext: mockToolContext,
      })) as CodeExecutionResult;

      expect(result.stdout).toBe('confirmed output');
      expect(mockExecutor.executeCodeParams?.codeExecutionInput.code).toBe(
        'console.log("go");',
      );
      // No new confirmation was requested when already confirmed.
      expect(
        mockToolContext.actions.requestedToolConfirmations['fc-3'],
      ).toBeUndefined();
    });
  });

  describe('error codes', () => {
    it('exposes stable string values for the error-code enum', () => {
      // The error-code string values are part of the tool's response contract
      // and must remain stable across releases.
      expect(RunSkillInlineScriptErrorCode.MISSING_SCRIPT_CONTENT).toBe(
        'MISSING_SCRIPT_CONTENT',
      );
      expect(RunSkillInlineScriptErrorCode.MISSING_LANGUAGE).toBe(
        'MISSING_LANGUAGE',
      );
      expect(RunSkillInlineScriptErrorCode.NO_CODE_EXECUTOR).toBe(
        'NO_CODE_EXECUTOR',
      );
      expect(RunSkillInlineScriptErrorCode.EXECUTION_ERROR).toBe(
        'EXECUTION_ERROR',
      );
      expect(RunSkillInlineScriptErrorCode.CONFIRMATION_REJECTED).toBe(
        'CONFIRMATION_REJECTED',
      );
    });
  });

  describe('artifact persistence', () => {
    const INLINE_SCRIPT_ARGS = {
      script_content: 'console.log("go");',
      language: CodeExecutionLanguage.JAVASCRIPT,
    };
    const outputFile: File = {
      name: 'report.txt',
      content: 'inline script output',
      contentEncoding: FileContentEncoding.UTF8,
      mimeType: 'text/plain',
    };

    function createExecutor(): MockCodeExecutor {
      const executor = new MockCodeExecutor();
      executor.mockResult = {
        stdout: 'inline ran',
        stderr: '',
        outputFiles: [{...outputFile}],
      };
      return executor;
    }

    function createArtifactService(): ScopedArtifactService {
      return new ScopedArtifactService(
        new InMemoryArtifactService(),
        'test-app',
        'test-user',
        'test-session',
      );
    }

    function runInlineScript(
      executor: MockCodeExecutor,
      artifactService?: ScopedArtifactService,
    ): Promise<unknown> {
      const toolset = new SkillToolset([], {codeExecutor: executor});
      return new RunSkillInlineScriptTool(toolset).runAsync({
        args: INLINE_SCRIPT_ARGS,
        toolContext: createMockContext('test-agent', executor, {
          toolConfirmation: confirmed(),
          artifactService,
        }),
      });
    }

    beforeEach(() => {
      vi.mocked(materializeFiles).mockImplementation(async (files) => files);
    });

    afterEach(() => {
      vi.mocked(materializeFiles).mockImplementation(async (files) => files);
      vi.restoreAllMocks();
    });

    it('reports saved artifacts when an artifact service is configured', async () => {
      const artifactService = createArtifactService();

      const result = (await runInlineScript(
        createExecutor(),
        artifactService,
      )) as ArtifactAugmentedResult;

      expect(result.savedArtifacts).toEqual({'report.txt': 0});
      expect(result.outputFiles).toEqual([outputFile]);

      const saved = await artifactService.loadArtifact({
        filename: 'report.txt',
      });
      const data = saved?.inlineData?.data;
      if (data === undefined) {
        expect.fail('expected the saved artifact to carry inline data');
      }
      expect(Buffer.from(data, 'base64').toString('utf-8')).toBe(
        'inline script output',
      );
    });

    it('saves under the executor-reported name, not the materialized one', async () => {
      const artifactService = createArtifactService();
      const saveSpy = vi.spyOn(artifactService, 'saveArtifact');
      vi.mocked(materializeFiles).mockImplementation(async (files) => {
        files.forEach((file) => {
          file.name = `renamed_${file.name}`;
        });
        return files;
      });

      const result = (await runInlineScript(
        createExecutor(),
        artifactService,
      )) as ArtifactAugmentedResult;

      expect(saveSpy).toHaveBeenCalledWith(
        expect.objectContaining({filename: 'report.txt'}),
      );
      expect(result.savedArtifacts).toEqual({'report.txt': 0});
      expect(result.outputFiles[0].name).toBe('renamed_report.txt');
    });

    it('saves artifacts before materializing the files', async () => {
      const calls: string[] = [];
      const artifactService = createArtifactService();
      vi.spyOn(artifactService, 'saveArtifact').mockImplementation(async () => {
        calls.push('saveArtifact');
        return 0;
      });
      vi.mocked(materializeFiles).mockImplementation(async (files) => {
        calls.push('materializeFiles');
        return files;
      });

      await runInlineScript(createExecutor(), artifactService);

      expect(calls).toEqual(['saveArtifact', 'materializeFiles']);
    });

    it('returns the plain result when no artifact service is configured', async () => {
      const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});

      const result = (await runInlineScript(
        createExecutor(),
      )) as CodeExecutionResult;

      expect(result).not.toHaveProperty('savedArtifacts');
      expect(result.stdout).toBe('inline ran');
      expect(result.outputFiles).toEqual([outputFile]);
      // The pre-existing no-artifact-service setup must stay quiet.
      expect(warnSpy).not.toHaveBeenCalled();
    });

    it('omits savedArtifacts and still succeeds when every save fails', async () => {
      const artifactService = createArtifactService();
      vi.spyOn(artifactService, 'saveArtifact').mockRejectedValue(
        new Error('artifact backend unavailable'),
      );

      const result = (await runInlineScript(
        createExecutor(),
        artifactService,
      )) as CodeExecutionResult;

      expect(result).not.toHaveProperty('savedArtifacts');
      expect(result).not.toHaveProperty('error');
      expect(result.stdout).toBe('inline ran');
      expect(result.outputFiles).toEqual([outputFile]);
    });

    it('never saves an artifact when the confirmation gate has not passed', async () => {
      const artifactService = createArtifactService();
      const saveSpy = vi.spyOn(artifactService, 'saveArtifact');
      const executor = createExecutor();
      const tool = new RunSkillInlineScriptTool(
        new SkillToolset([], {codeExecutor: executor}),
      );

      const pending = (await tool.runAsync({
        args: INLINE_SCRIPT_ARGS,
        toolContext: createMockContext('test-agent', executor, {
          functionCallId: 'fc-artifact',
          artifactService,
        }),
      })) as {partial: string};
      const rejected = (await tool.runAsync({
        args: INLINE_SCRIPT_ARGS,
        toolContext: createMockContext('test-agent', executor, {
          toolConfirmation: new ToolConfirmation({confirmed: false}),
          artifactService,
        }),
      })) as ToolErrorResponse;

      expect(pending.partial).toBeDefined();
      expect(rejected.errorCode).toBe(
        RunSkillInlineScriptErrorCode.CONFIRMATION_REJECTED,
      );
      expect(executor.executeCodeParams).toBeUndefined();
      expect(saveSpy).not.toHaveBeenCalled();
    });
  });
});
