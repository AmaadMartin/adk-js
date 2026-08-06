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
  RunSkillScriptErrorCode,
  RunSkillScriptTool,
  Skill,
  SkillToolset,
} from '@google/adk';
import {describe, expect, it, vi} from 'vitest';
import {materializeFiles} from '../../../src/utils/file_utils.js';

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
    invocationId = 'inv-1',
    sessionState: Record<string, unknown> = {},
  ): Context {
    const agentObj: Record<string | symbol, unknown> = {name: agentName};
    if (agentExecutor) {
      agentObj['codeExecutor'] = agentExecutor;
      agentObj[Symbol.for('google.adk.llmAgent')] = true;
    }

    return new Context({
      invocationContext: {
        invocationId,
        session: {state: sessionState},
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

  it('returns SCRIPT_NOT_FOUND on the first script lookup miss', async () => {
    const toolset = new SkillToolset([mockSkill]);
    const tool = new RunSkillScriptTool(toolset);
    const result = (await tool.runAsync({
      args: {skill_name: 'test-skill', script_path: 'scripts/invalid.js'},
      toolContext: createMockContext(),
    })) as ToolErrorResponse;

    expect(result.errorCode).toBe(RunSkillScriptErrorCode.SCRIPT_NOT_FOUND);
    expect(result.error).not.toContain('#');
  });

  it('escalates to SCRIPT_NOT_FOUND_FATAL on the second miss in the same invocation', async () => {
    const toolset = new SkillToolset([mockSkill]);
    const tool = new RunSkillScriptTool(toolset);
    const toolContext = createMockContext();
    const args = {skill_name: 'test-skill', script_path: 'scripts/invalid.js'};

    const first = (await tool.runAsync({
      args,
      toolContext,
    })) as ToolErrorResponse;
    const second = (await tool.runAsync({
      args,
      toolContext,
    })) as ToolErrorResponse;

    expect(first).toEqual({
      error: "Script 'scripts/invalid.js' not found in skill 'test-skill'.",
      errorCode: RunSkillScriptErrorCode.SCRIPT_NOT_FOUND,
    });
    expect(second).toEqual({
      error:
        "Script 'scripts/invalid.js' not found in skill 'test-skill'. This is" +
        ' script lookup failure #2 this invocation. Do not retry any script' +
        ' path — report the error to the user and stop.',
      errorCode: RunSkillScriptErrorCode.SCRIPT_NOT_FOUND_FATAL,
    });
  });

  it('escalates even when the second miss uses a different script path', async () => {
    const toolset = new SkillToolset([mockSkill]);
    const tool = new RunSkillScriptTool(toolset);
    const toolContext = createMockContext();

    const first = (await tool.runAsync({
      args: {skill_name: 'test-skill', script_path: 'scripts/invalid.js'},
      toolContext,
    })) as ToolErrorResponse;
    const second = (await tool.runAsync({
      args: {
        skill_name: 'test-skill',
        script_path: 'scripts/some-other-guess.ts',
      },
      toolContext,
    })) as ToolErrorResponse;

    expect(first.errorCode).toBe(RunSkillScriptErrorCode.SCRIPT_NOT_FOUND);
    expect(second).toEqual({
      error:
        "Script 'scripts/some-other-guess.ts' not found in skill 'test-skill'." +
        ' This is script lookup failure #2 this invocation. Do not retry any' +
        ' script path — report the error to the user and stop.',
      errorCode: RunSkillScriptErrorCode.SCRIPT_NOT_FOUND_FATAL,
    });
  });

  it('resets the counter for a new invocation id', async () => {
    const toolset = new SkillToolset([mockSkill]);
    const tool = new RunSkillScriptTool(toolset);
    const sharedState: Record<string, unknown> = {};
    const args = {skill_name: 'test-skill', script_path: 'scripts/invalid.js'};
    const firstInvocation = createMockContext(
      'test-agent',
      undefined,
      'inv-1',
      sharedState,
    );
    const secondInvocation = createMockContext(
      'test-agent',
      undefined,
      'inv-2',
      sharedState,
    );

    await tool.runAsync({args, toolContext: firstInvocation});
    const secondMiss = (await tool.runAsync({
      args,
      toolContext: firstInvocation,
    })) as ToolErrorResponse;
    const newInvocationMiss = (await tool.runAsync({
      args,
      toolContext: secondInvocation,
    })) as ToolErrorResponse;

    expect(secondMiss.errorCode).toBe(
      RunSkillScriptErrorCode.SCRIPT_NOT_FOUND_FATAL,
    );
    expect(newInvocationMiss).toEqual({
      error: "Script 'scripts/invalid.js' not found in skill 'test-skill'.",
      errorCode: RunSkillScriptErrorCode.SCRIPT_NOT_FOUND,
    });
    expect(sharedState).toEqual({
      'temp:_adk_skill_script_not_found_count_inv-1': 2,
      'temp:_adk_skill_script_not_found_count_inv-2': 1,
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

  it('returns error if the code executor throws', async () => {
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

  describe('error codes', () => {
    it('exposes stable string values for the error-code enum', () => {
      // The error-code string values are part of the tool's response contract
      // and must remain stable across releases.
      expect(RunSkillScriptErrorCode.MISSING_SKILL_NAME).toBe(
        'MISSING_SKILL_NAME',
      );
      expect(RunSkillScriptErrorCode.MISSING_SCRIPT_PATH).toBe(
        'MISSING_SCRIPT_PATH',
      );
      expect(RunSkillScriptErrorCode.REGISTRY_ERROR).toBe('REGISTRY_ERROR');
      expect(RunSkillScriptErrorCode.SKILL_NOT_FOUND).toBe('SKILL_NOT_FOUND');
      expect(RunSkillScriptErrorCode.SCRIPT_NOT_FOUND).toBe('SCRIPT_NOT_FOUND');
      expect(RunSkillScriptErrorCode.NO_CODE_EXECUTOR).toBe('NO_CODE_EXECUTOR');
      expect(RunSkillScriptErrorCode.EXECUTION_ERROR).toBe('EXECUTION_ERROR');
    });

    it('exposes the fatal script-lookup code shared with the Python SDK', () => {
      expect(RunSkillScriptErrorCode.SCRIPT_NOT_FOUND_FATAL).toBe(
        'SCRIPT_NOT_FOUND_FATAL',
      );
    });
  });
});
