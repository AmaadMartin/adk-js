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

  const unsupportedLanguageSkill: Skill = {
    frontmatter: {name: 'ts-skill', description: 'Ships non-runnable scripts'},
    instructions: 'Test instructions',
    resources: {
      scripts: {
        'setup.ts': {src: 'const x: number = 1; console.log(x);'},
        'notes.txt': {src: 'not a script'},
      },
    },
  };

  const pythonSkill: Skill = {
    frontmatter: {name: 'python-skill', description: 'Ships a Python script'},
    instructions: 'Test instructions',
    resources: {scripts: {'build.py': {src: 'print("build")'}}},
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

  it('declares the supported script extensions to the model', () => {
    const tool = new RunSkillScriptTool(new SkillToolset([mockSkill]));

    const declaration = tool._getDeclaration();

    expect(
      declaration.parameters?.properties?.['script_path'].description,
    ).toBe(
      "The relative path to the script (e.g., 'scripts/setup.js'). " +
        'Supported extensions: .js, .py, .sh, .ps1, .bat, .cmd.',
    );
  });

  it('refuses a TypeScript script before reaching the executor', async () => {
    const mockExecutor = new MockCodeExecutor();
    const toolset = new SkillToolset([unsupportedLanguageSkill], {
      codeExecutor: mockExecutor,
    });
    const tool = new RunSkillScriptTool(toolset);

    const result = (await tool.runAsync({
      args: {skill_name: 'ts-skill', script_path: 'scripts/setup.ts'},
      toolContext: createMockContext(),
    })) as ToolErrorResponse;

    expect(result).toEqual({
      error:
        "Script 'scripts/setup.ts' has unsupported language 'typescript'. " +
        'Skill scripts must be one of: .js, .py, .sh, .ps1, .bat, .cmd.',
      errorCode: RunSkillScriptErrorCode.UNSUPPORTED_SCRIPT_LANGUAGE,
    });
    expect(mockExecutor.executeCodeParams).toBeUndefined();
  });

  it('refuses a TypeScript script requested without the scripts/ prefix', async () => {
    const mockExecutor = new MockCodeExecutor();
    const toolset = new SkillToolset([unsupportedLanguageSkill], {
      codeExecutor: mockExecutor,
    });
    const tool = new RunSkillScriptTool(toolset);

    const result = (await tool.runAsync({
      args: {skill_name: 'ts-skill', script_path: 'setup.ts'},
      toolContext: createMockContext(),
    })) as ToolErrorResponse;

    expect(result).toEqual({
      error:
        "Script 'setup.ts' has unsupported language 'typescript'. " +
        'Skill scripts must be one of: .js, .py, .sh, .ps1, .bat, .cmd.',
      errorCode: RunSkillScriptErrorCode.UNSUPPORTED_SCRIPT_LANGUAGE,
    });
    expect(mockExecutor.executeCodeParams).toBeUndefined();
  });

  it('refuses an extension that maps to no language', async () => {
    const mockExecutor = new MockCodeExecutor();
    const toolset = new SkillToolset([unsupportedLanguageSkill], {
      codeExecutor: mockExecutor,
    });
    const tool = new RunSkillScriptTool(toolset);

    const result = (await tool.runAsync({
      args: {skill_name: 'ts-skill', script_path: 'scripts/notes.txt'},
      toolContext: createMockContext(),
    })) as ToolErrorResponse;

    expect(result).toEqual({
      error:
        "Script 'scripts/notes.txt' has unsupported language 'unspecified'. " +
        'Skill scripts must be one of: .js, .py, .sh, .ps1, .bat, .cmd.',
      errorCode: RunSkillScriptErrorCode.UNSUPPORTED_SCRIPT_LANGUAGE,
    });
    expect(mockExecutor.executeCodeParams).toBeUndefined();
  });

  it('still executes a Python script with the runpy wrapper', async () => {
    const mockExecutor = new MockCodeExecutor();
    const toolset = new SkillToolset([pythonSkill], {
      codeExecutor: mockExecutor,
    });
    const tool = new RunSkillScriptTool(toolset);

    await tool.runAsync({
      args: {skill_name: 'python-skill', script_path: 'scripts/build.py'},
      toolContext: createMockContext(),
    });

    expect(mockExecutor.executeCodeParams?.codeExecutionInput.code).toBe(
      "import runpy\nrunpy.run_path('./scripts/build.py', run_name='__main__')",
    );
    expect(mockExecutor.executeCodeParams?.codeExecutionInput.language).toBe(
      CodeExecutionLanguage.PYTHON,
    );
  });

  it('still executes a Shell script with the source wrapper', async () => {
    const mockExecutor = new MockCodeExecutor();
    const toolset = new SkillToolset([mockSkill], {codeExecutor: mockExecutor});
    const tool = new RunSkillScriptTool(toolset);

    await tool.runAsync({
      args: {skill_name: 'test-skill', script_path: 'scripts/run.sh'},
      toolContext: createMockContext(),
    });

    expect(mockExecutor.executeCodeParams?.codeExecutionInput.code).toBe(
      'source ./scripts/run.sh "$@"',
    );
    expect(mockExecutor.executeCodeParams?.codeExecutionInput.language).toBe(
      CodeExecutionLanguage.SHELL,
    );
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

    it('exposes a stable string value for the unsupported-language code', () => {
      expect(RunSkillScriptErrorCode.UNSUPPORTED_SCRIPT_LANGUAGE).toBe(
        'UNSUPPORTED_SCRIPT_LANGUAGE',
      );
    });
  });
});
