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
import {runInNewContext} from 'node:vm';
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

  describe('TypeScript wrapper', () => {
    const tsSkill: Skill = {
      frontmatter: {
        name: 'ts-skill',
        description: 'A TypeScript test skill',
      },
      instructions: 'Test instructions',
      resources: {
        scripts: {
          'setup.ts': {src: 'console.log("setup");'},
        },
      },
    };

    /** Runs the tool over a .ts script and returns the wrapper it emitted. */
    async function emitWrapper(): Promise<{
      code: string;
      language: CodeExecutionLanguage | undefined;
    }> {
      const mockExecutor = new MockCodeExecutor();
      const toolset = new SkillToolset([tsSkill], {codeExecutor: mockExecutor});
      const tool = new RunSkillScriptTool(toolset);

      await tool.runAsync({
        args: {skill_name: 'ts-skill', script_path: 'scripts/setup.ts'},
        toolContext: createMockContext(),
      });

      const input = mockExecutor.executeCodeParams?.codeExecutionInput;
      if (!input?.code) {
        expect.fail('the executor received no code to run');
      }
      return {code: input.code, language: input.language};
    }

    /** Executes emitted guest source with `require` under the test's control. */
    function runGuest(
      code: string,
      requireImpl: (id: string) => unknown,
    ): void {
      runInNewContext(code, {require: requireImpl});
    }

    function moduleNotFound(id: string): Error {
      return Object.assign(new Error(`Cannot find module '${id}'`), {
        code: 'MODULE_NOT_FOUND',
      });
    }

    it('registers ts-node and then loads the script', async () => {
      const {code, language} = await emitWrapper();
      const required: string[] = [];

      runGuest(code, (id) => {
        required.push(id);
        return {};
      });

      expect(required).toEqual(['ts-node/register', './scripts/setup.ts']);
      expect(language).toBe(CodeExecutionLanguage.TYPESCRIPT);
    });

    it('reports an actionable error when ts-node is not installed', async () => {
      const {code} = await emitWrapper();

      expect(() =>
        runGuest(code, (id) => {
          throw moduleNotFound(id);
        }),
      ).toThrow(
        "Cannot run a TypeScript skill script: 'ts-node' is not installed in the code execution environment. Install ts-node there, or provide the script as JavaScript.",
      );
    });

    it('rethrows a ts-node failure that is not a missing module', async () => {
      const {code} = await emitWrapper();

      expect(() =>
        runGuest(code, () => {
          throw new Error('tsconfig.json is invalid');
        }),
      ).toThrow('tsconfig.json is invalid');
    });

    it('does not load the script when ts-node is missing', async () => {
      const {code} = await emitWrapper();
      const required: string[] = [];

      expect(() =>
        runGuest(code, (id) => {
          required.push(id);
          throw moduleNotFound(id);
        }),
      ).toThrow();
      expect(required).toEqual(['ts-node/register']);
    });
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
});
