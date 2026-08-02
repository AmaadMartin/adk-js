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
  InvocationContext,
  LlmAgent,
  RunSkillScriptTool,
  Skill,
  SkillToolset,
} from '@google/adk';
import {describe, expect, it, vi} from 'vitest';
import {materializeFiles} from '../../../src/utils/file_utils.js';
import {DEFAULT_MAX_OUTPUT_CHARS} from '../../../src/utils/truncate_utils.js';

vi.mock('../../../src/utils/file_utils.js', () => ({
  materializeFiles: vi.fn(),
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
  errorCode: string;
}

describe('RunSkillScriptTool', () => {
  function createMockContext(
    agentName = 'test-agent',
    agentExecutor?: BaseCodeExecutor,
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
      } as unknown as InvocationContext,
    });
  }

  const mockSkill: Skill = {
    frontmatter: {
      name: 'test-skill',
      description: 'A test skill',
    },
    instructions: 'Test instructions',
    resources: {
      scripts: {
        'setup.js': {src: 'console.log("setup");'},
        'run.sh': {src: 'echo "run";'},
      },
      references: {
        'doc.txt': 'Doc content',
      },
      assets: {
        'binary.dat': Buffer.from('hello', 'utf8'),
      },
    },
  };

  it('returns error if skill name is missing', async () => {
    const toolset = new SkillToolset([mockSkill]);
    const tool = new RunSkillScriptTool(toolset);
    const result = (await tool.runAsync({
      args: {script_path: 'scripts/setup.js'},
      toolContext: createMockContext(),
    })) as ToolErrorResponse;

    expect(result).toEqual({
      error: 'Skill name is required.',
      errorCode: 'MISSING_SKILL_NAME',
    });
  });

  it('returns error if script path is missing', async () => {
    const toolset = new SkillToolset([mockSkill]);
    const tool = new RunSkillScriptTool(toolset);
    const result = (await tool.runAsync({
      args: {skill_name: 'test-skill'},
      toolContext: createMockContext(),
    })) as ToolErrorResponse;

    expect(result).toEqual({
      error: 'Script path is required.',
      errorCode: 'MISSING_SCRIPT_PATH',
    });
  });

  it('returns error if skill not found', async () => {
    const toolset = new SkillToolset([mockSkill]);
    const tool = new RunSkillScriptTool(toolset);
    const result = (await tool.runAsync({
      args: {skill_name: 'invalid-skill', script_path: 'scripts/setup.js'},
      toolContext: createMockContext(),
    })) as ToolErrorResponse;

    expect(result).toEqual({
      error: "Skill 'invalid-skill' not found.",
      errorCode: 'SKILL_NOT_FOUND',
    });
  });

  it('returns error if script not found in skill', async () => {
    const toolset = new SkillToolset([mockSkill]);
    const tool = new RunSkillScriptTool(toolset);
    const result = (await tool.runAsync({
      args: {skill_name: 'test-skill', script_path: 'scripts/invalid.js'},
      toolContext: createMockContext(),
    })) as ToolErrorResponse;

    expect(result).toEqual({
      error: "Script 'scripts/invalid.js' not found in skill 'test-skill'.",
      errorCode: 'SCRIPT_NOT_FOUND',
    });
  });

  it('returns error if no code executor configured', async () => {
    const toolset = new SkillToolset([mockSkill]); // no executor
    const tool = new RunSkillScriptTool(toolset);
    const result = (await tool.runAsync({
      args: {skill_name: 'test-skill', script_path: 'scripts/setup.js'},
      toolContext: createMockContext(),
    })) as ToolErrorResponse;

    expect(result).toEqual({
      error: 'No code executor configured.',
      errorCode: 'NO_CODE_EXECUTOR',
    });
  });

  it('executes script successfully via mock executor with JS wrapper', async () => {
    const mockExecutor = new MockCodeExecutor();
    const toolset = new SkillToolset([mockSkill], {codeExecutor: mockExecutor});
    const tool = new RunSkillScriptTool(toolset);

    const result = (await tool.runAsync({
      args: {skill_name: 'test-skill', script_path: 'scripts/setup.js'},
      toolContext: createMockContext(),
    })) as CodeExecutionResult;

    expect(result.stdout).toBe('');
    expect(mockExecutor.executeCodeParams?.codeExecutionInput.code).toBe(
      "require('./scripts/setup.js');",
    );
    expect(mockExecutor.executeCodeParams?.codeExecutionInput.language).toBe(
      CodeExecutionLanguage.JAVASCRIPT,
    );
  });

  it('extracts skill resource files correctly', async () => {
    const mockExecutor = new MockCodeExecutor();
    const toolset = new SkillToolset([mockSkill], {codeExecutor: mockExecutor});
    const tool = new RunSkillScriptTool(toolset);

    await tool.runAsync({
      args: {skill_name: 'test-skill', script_path: 'scripts/setup.js'},
      toolContext: createMockContext(),
    });

    const inputFiles =
      mockExecutor.executeCodeParams?.codeExecutionInput.inputFiles;
    expect(inputFiles).toBeDefined();

    // 1 script, 1 reference, 1 asset
    expect(inputFiles?.length).toBe(4); // setup.js, run.sh, doc.txt, binary.dat

    const fileNames = inputFiles?.map((f) => f.name);
    expect(fileNames).toContain('scripts/setup.js');
    expect(fileNames).toContain('scripts/run.sh');
    expect(fileNames).toContain('references/doc.txt');
    expect(fileNames).toContain('assets/binary.dat');

    const binaryFile = inputFiles?.find((f) => f.name === 'assets/binary.dat');
    expect(binaryFile?.contentEncoding).toBe('base64');
  });

  it('calls materializeFiles with output files from executor', async () => {
    const mockExecutor = new MockCodeExecutor();
    const testFile = {
      name: 'output.txt',
      content: 'hello',
      contentEncoding: 'utf8',
      mimeType: 'text/plain',
    } as File;
    mockExecutor.mockResult = {
      stdout: '',
      stderr: '',
      outputFiles: [testFile],
    };

    const toolset = new SkillToolset([mockSkill], {codeExecutor: mockExecutor});
    const tool = new RunSkillScriptTool(toolset);

    await tool.runAsync({
      args: {skill_name: 'test-skill', script_path: 'scripts/setup.js'},
      toolContext: createMockContext(),
    });

    expect(materializeFiles).toHaveBeenCalledWith([testFile]);
  });

  it('returns execution error when executor throws', async () => {
    const mockExecutor = new MockCodeExecutor();
    mockExecutor.shouldThrow = true;
    const toolset = new SkillToolset([mockSkill], {codeExecutor: mockExecutor});
    const tool = new RunSkillScriptTool(toolset);

    const result = (await tool.runAsync({
      args: {skill_name: 'test-skill', script_path: 'scripts/setup.js'},
      toolContext: createMockContext(),
    })) as ToolErrorResponse;

    expect(result).toEqual({
      error:
        "Failed to execute script 'scripts/setup.js': Mock execution failure",
      errorCode: 'EXECUTION_ERROR',
    });
  });

  describe('output truncation', () => {
    async function runWith(
      mockResult: CodeExecutionResult,
      maxOutputChars?: number,
    ): Promise<CodeExecutionResult> {
      const mockExecutor = new MockCodeExecutor();
      mockExecutor.mockResult = mockResult;
      const toolset = new SkillToolset([mockSkill], {
        codeExecutor: mockExecutor,
        maxOutputChars,
      });
      const tool = new RunSkillScriptTool(toolset);

      return (await tool.runAsync({
        args: {skill_name: 'test-skill', script_path: 'scripts/setup.js'},
        toolContext: createMockContext(),
      })) as CodeExecutionResult;
    }

    it('returns stdout below the cap verbatim', async () => {
      const stdout = 'a'.repeat(DEFAULT_MAX_OUTPUT_CHARS);

      const result = await runWith({stdout, stderr: '', outputFiles: []});

      expect(result.stdout).toBe(stdout);
    });

    it('truncates stdout above the cap', async () => {
      const stdout = 'a'.repeat(DEFAULT_MAX_OUTPUT_CHARS) + 'bbb';

      const result = await runWith({stdout, stderr: '', outputFiles: []});

      const half = DEFAULT_MAX_OUTPUT_CHARS / 2;
      expect(result.stdout.startsWith('a'.repeat(half))).toBe(true);
      expect(result.stdout.endsWith('bbb')).toBe(true);
      expect(result.stdout).toContain('... [truncated 3 characters] ...');
    });

    it('truncates stderr above the cap while leaving a short stdout verbatim', async () => {
      const stderr = 'e'.repeat(DEFAULT_MAX_OUTPUT_CHARS + 10);

      const result = await runWith({stdout: 'ok', stderr, outputFiles: []});

      expect(result.stdout).toBe('ok');
      expect(result.stderr).toContain('... [truncated 10 characters] ...');
    });

    it('caps stdout and stderr independently in one call', async () => {
      const result = await runWith(
        {stdout: '0123456789', stderr: 'abcdefghij', outputFiles: []},
        4,
      );

      expect(result.stdout).toBe('01\n... [truncated 6 characters] ...\n89');
      expect(result.stderr).toBe('ab\n... [truncated 6 characters] ...\nij');
    });

    it('honours a custom maxOutputChars on the toolset', async () => {
      const result = await runWith(
        {stdout: 'x'.repeat(30), stderr: '', outputFiles: []},
        10,
      );

      expect(result.stdout).toBe(
        `${'x'.repeat(5)}\n... [truncated 20 characters] ...\n${'x'.repeat(5)}`,
      );
    });

    it('does not mutate the executor result', async () => {
      const stdout = 'y'.repeat(50);
      const mockExecutor = new MockCodeExecutor();
      mockExecutor.mockResult = {stdout, stderr: '', outputFiles: []};
      const toolset = new SkillToolset([mockSkill], {
        codeExecutor: mockExecutor,
        maxOutputChars: 10,
      });
      const tool = new RunSkillScriptTool(toolset);

      const result = (await tool.runAsync({
        args: {skill_name: 'test-skill', script_path: 'scripts/setup.js'},
        toolContext: createMockContext(),
      })) as CodeExecutionResult;

      expect(result.stdout).not.toBe(stdout);
      expect(mockExecutor.mockResult.stdout).toBe(stdout);
    });
  });
});
