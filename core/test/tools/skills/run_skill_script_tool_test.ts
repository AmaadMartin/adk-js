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
  RunSkillScriptErrorCode,
  RunSkillScriptTool,
  Skill,
  SkillScriptResult,
  SkillToolset,
} from '@google/adk';
import {describe, expect, it, vi} from 'vitest';
import {materializeScriptOutputs} from '../../../src/tools/skill/script_output_utils.js';

vi.mock('../../../src/tools/skill/script_output_utils.js', () => ({
  materializeScriptOutputs: vi.fn((result: CodeExecutionResult) => result),
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

  it('sends a TypeScript script resource as UTF-8 text', async () => {
    const typescriptSkill: Skill = {
      frontmatter: {
        name: 'typescript-skill',
        description: 'A skill with a TypeScript script',
      },
      instructions: 'Test instructions',
      resources: {
        scripts: {'helper.ts': {src: 'export const x = 1;'}},
      },
    };
    const mockExecutor = new MockCodeExecutor();
    const toolset = new SkillToolset([typescriptSkill], {
      codeExecutor: mockExecutor,
    });
    const tool = new RunSkillScriptTool(toolset);

    await tool.runAsync({
      args: {
        skill_name: 'typescript-skill',
        script_path: 'scripts/helper.ts',
      },
      toolContext: createMockContext(),
    });

    const helper =
      mockExecutor.executeCodeParams?.codeExecutionInput.inputFiles?.find(
        (f) => f.name === 'scripts/helper.ts',
      );
    expect(helper?.contentEncoding).toBe(FileContentEncoding.UTF8);
    expect(helper?.mimeType).toBe('text/javascript');
    expect(helper?.content).toBe('export const x = 1;');
  });

  const testFile: File = {
    name: 'output.txt',
    content: 'hello',
    contentEncoding: FileContentEncoding.UTF8,
    mimeType: 'text/plain',
  };

  function executorReturning(outputFiles: File[]): MockCodeExecutor {
    const mockExecutor = new MockCodeExecutor();
    mockExecutor.mockResult = {stdout: '', stderr: '', outputFiles};
    return mockExecutor;
  }

  async function runTool(toolset: SkillToolset): Promise<unknown> {
    return new RunSkillScriptTool(toolset).runAsync({
      args: {skill_name: 'test-skill', script_path: 'scripts/setup.js'},
      toolContext: createMockContext(),
    });
  }

  it('materializes output files with no directory when none is configured', async () => {
    const mockExecutor = executorReturning([testFile]);

    await runTool(new SkillToolset([mockSkill], {codeExecutor: mockExecutor}));

    expect(materializeScriptOutputs).toHaveBeenCalledWith(
      mockExecutor.mockResult,
      undefined,
    );
  });

  it('passes the toolset outputDir through', async () => {
    const mockExecutor = executorReturning([testFile]);

    await runTool(
      new SkillToolset([mockSkill], {
        codeExecutor: mockExecutor,
        outputDir: '/configured/dir',
      }),
    );

    expect(materializeScriptOutputs).toHaveBeenCalledWith(
      mockExecutor.mockResult,
      '/configured/dir',
    );
  });

  it('returns the outputDir reported by the helper', async () => {
    const mockExecutor = executorReturning([testFile]);
    vi.mocked(materializeScriptOutputs).mockResolvedValueOnce({
      ...mockExecutor.mockResult,
      outputDir: '/somewhere',
    });

    const result = (await runTool(
      new SkillToolset([mockSkill], {codeExecutor: mockExecutor}),
    )) as SkillScriptResult;

    expect(result.outputDir).toBe('/somewhere');
  });

  it('returns error if the executor throws', async () => {
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
  });
});
