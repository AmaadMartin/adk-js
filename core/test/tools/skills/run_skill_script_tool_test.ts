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
  MaterializedCodeExecutionResult,
  RunSkillScriptTool,
  Skill,
  SkillToolset,
} from '@google/adk';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {materializeFiles} from '../../../src/utils/file_utils.js';

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
  errorCode: string;
}

describe('RunSkillScriptTool', () => {
  beforeEach(() => {
    // Keep the mock factory's implementation, drop recorded calls so each
    // assertion pins its own call rather than a historical one.
    vi.mocked(materializeFiles).mockClear();
  });

  // Only materializeFiles is mocked, so the tool still creates its output
  // directory on the real filesystem.
  afterEach(async () => {
    await Promise.all(
      materializeFilesDirs().map((dir) =>
        fs.rm(dir, {recursive: true, force: true}),
      ),
    );
  });

  /** Directories the tool passed to materializeFiles during this test. */
  function materializeFilesDirs(): string[] {
    return vi
      .mocked(materializeFiles)
      .mock.calls.map((call) => call[1])
      .filter((dir): dir is string => dir !== undefined);
  }

  /**
   * Returns the single directory the tool materialized into, failing the test
   * when it did not call materializeFiles exactly once with one.
   */
  function onlyMaterializeFilesDir(): string {
    const dirs = materializeFilesDirs();
    if (dirs.length !== 1) {
      return expect.fail(
        `expected one materializeFiles call with a directory, got ${dirs.length}`,
      );
    }
    return dirs[0];
  }

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

  const testFile: File = {
    name: 'output.txt',
    content: 'hello',
    contentEncoding: FileContentEncoding.UTF8,
    mimeType: 'text/plain',
  };

  function runWithOutputFiles(
    outputFiles: File[],
    toolsetOptions: {outputDir?: string} = {},
  ): Promise<unknown> {
    const mockExecutor = new MockCodeExecutor();
    mockExecutor.mockResult = {stdout: '', stderr: '', outputFiles};
    const toolset = new SkillToolset([mockSkill], {
      codeExecutor: mockExecutor,
      ...toolsetOptions,
    });

    return new RunSkillScriptTool(toolset).runAsync({
      args: {skill_name: 'test-skill', script_path: 'scripts/setup.js'},
      toolContext: createMockContext(),
    });
  }

  it('materializes output files into a tool-owned temp directory', async () => {
    await runWithOutputFiles([testFile]);

    expect(materializeFiles).toHaveBeenCalledWith(
      [testFile],
      expect.any(String),
    );
    const dir = onlyMaterializeFilesDir();
    expect(path.isAbsolute(dir)).toBe(true);
    expect(path.dirname(dir)).toBe(path.resolve(os.tmpdir()));
    expect(path.basename(dir).startsWith('adk-skill-output-')).toBe(true);
    expect(dir).not.toBe(process.cwd());
  });

  it('reports the directory it materialized into as outputDir', async () => {
    const result = (await runWithOutputFiles([
      testFile,
    ])) as MaterializedCodeExecutionResult;

    expect(result.outputDir).toBe(onlyMaterializeFilesDir());
    expect(result.outputFiles).toEqual([testFile]);
  });

  it('materializes into the declared output directory when configured', async () => {
    const declaredDir = await fs.mkdtemp(
      path.join(os.tmpdir(), 'run_skill_script_declared_'),
    );

    const result = (await runWithOutputFiles([testFile], {
      outputDir: declaredDir,
    })) as MaterializedCodeExecutionResult;

    expect(materializeFiles).toHaveBeenCalledWith(
      [testFile],
      path.resolve(declaredDir),
    );
    expect(result.outputDir).toBe(path.resolve(declaredDir));
  });

  it('materializes nothing when the executor produced no output files', async () => {
    const result = (await runWithOutputFiles(
      [],
    )) as MaterializedCodeExecutionResult;

    expect(materializeFiles).not.toHaveBeenCalled();
    expect('outputDir' in result).toBe(false);
  });

  it('surfaces a materialization failure as EXECUTION_ERROR', async () => {
    vi.mocked(materializeFiles).mockRejectedValueOnce(
      new Error('Path traversal detected'),
    );

    const result = (await runWithOutputFiles([testFile])) as ToolErrorResponse;

    expect(result).toEqual({
      error:
        "Failed to execute script 'scripts/setup.js': Path traversal detected",
      errorCode: 'EXECUTION_ERROR',
    });
  });
});
