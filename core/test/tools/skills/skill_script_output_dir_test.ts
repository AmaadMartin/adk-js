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
  PluginManager,
  RunSkillInlineScriptTool,
  RunSkillScriptTool,
  Skill,
  SkillToolset,
  createSession,
} from '@google/adk';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {ToolConfirmation} from '../../../src/tools/tool_confirmation.js';

/**
 * Unlike the other skill tool tests this file does not mock `file_utils`: the
 * point is to observe what the tools actually put on disk.
 */
class MockCodeExecutor extends BaseCodeExecutor {
  constructor(private readonly outputFiles: File[]) {
    super();
  }

  override async executeCode(
    _params: ExecuteCodeParams,
  ): Promise<CodeExecutionResult> {
    return {stdout: '', stderr: '', outputFiles: this.outputFiles};
  }
}

function textFile(name: string, content: string): File {
  return {
    name,
    content,
    contentEncoding: FileContentEncoding.UTF8,
    mimeType: 'text/plain',
  };
}

const mockSkill: Skill = {
  frontmatter: {name: 'test-skill', description: 'A test skill'},
  instructions: 'Test instructions',
  resources: {scripts: {'setup.js': {src: 'console.log("setup");'}}},
};

function createMockContext(): Context {
  return new Context({
    invocationContext: new InvocationContext({
      invocationId: 'test-invocation',
      agent: new LlmAgent({name: 'test_agent', model: 'gemini-2.5-flash'}),
      session: createSession({
        id: 'test-session',
        events: [],
        appName: 'test-app',
        userId: 'test-user',
      }),
      pluginManager: new PluginManager([]),
    }),
    // The inline script tool refuses to execute without a confirmation.
    toolConfirmation: new ToolConfirmation({confirmed: true}),
  });
}

function runScript(toolset: SkillToolset): Promise<unknown> {
  return new RunSkillScriptTool(toolset).runAsync({
    args: {skill_name: 'test-skill', script_path: 'scripts/setup.js'},
    toolContext: createMockContext(),
  });
}

function runInlineScript(toolset: SkillToolset): Promise<unknown> {
  return new RunSkillInlineScriptTool(toolset).runAsync({
    args: {
      script_content: 'console.log("test");',
      language: CodeExecutionLanguage.JAVASCRIPT,
    },
    toolContext: createMockContext(),
  });
}

describe('skill script output directory', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'skill_script_output_'));
  });

  afterEach(async () => {
    await fs.rm(tempDir, {recursive: true, force: true});
  });

  it('run_skill_script writes output files into the configured directory', async () => {
    const toolset = new SkillToolset([mockSkill], {
      codeExecutor: new MockCodeExecutor([textFile('output.txt', 'hello')]),
      outputDir: tempDir,
    });

    const result = (await runScript(toolset)) as CodeExecutionResult;

    expect(result.outputFiles?.[0].name).toBe('output.txt');
    expect(await fs.readFile(path.join(tempDir, 'output.txt'), 'utf8')).toBe(
      'hello',
    );
  });

  it('run_skill_script writes nothing when no output directory is configured', async () => {
    const outputFiles = [textFile('output.txt', 'hello')];
    const toolset = new SkillToolset([mockSkill], {
      codeExecutor: new MockCodeExecutor(outputFiles),
    });
    const cwdBefore = new Set(await fs.readdir(process.cwd()));

    const result = (await runScript(toolset)) as CodeExecutionResult;

    expect(new Set(await fs.readdir(process.cwd()))).toEqual(cwdBefore);
    expect(await fs.readdir(tempDir)).toEqual([]);
    expect(result.outputFiles).toEqual(outputFiles);
  });

  it('run_skill_inline_script writes output files into the configured directory', async () => {
    const toolset = new SkillToolset([], {
      codeExecutor: new MockCodeExecutor([textFile('output.txt', 'hello')]),
      outputDir: tempDir,
      allowInlineScripts: true,
    });

    const result = (await runInlineScript(toolset)) as CodeExecutionResult;

    expect(result.outputFiles?.[0].name).toBe('output.txt');
    expect(await fs.readFile(path.join(tempDir, 'output.txt'), 'utf8')).toBe(
      'hello',
    );
  });

  it('run_skill_inline_script writes nothing when no output directory is configured', async () => {
    const outputFiles = [textFile('output.txt', 'hello')];
    const toolset = new SkillToolset([], {
      codeExecutor: new MockCodeExecutor(outputFiles),
      allowInlineScripts: true,
    });
    const cwdBefore = new Set(await fs.readdir(process.cwd()));

    const result = (await runInlineScript(toolset)) as CodeExecutionResult;

    expect(new Set(await fs.readdir(process.cwd()))).toEqual(cwdBefore);
    expect(await fs.readdir(tempDir)).toEqual([]);
    expect(result.outputFiles).toEqual(outputFiles);
  });

  it('suffixes colliding names inside the configured directory', async () => {
    const toolset = new SkillToolset([mockSkill], {
      codeExecutor: new MockCodeExecutor([
        textFile('output.txt', 'first'),
        textFile('output.txt', 'second'),
      ]),
      outputDir: tempDir,
    });

    const result = (await runScript(toolset)) as CodeExecutionResult;

    expect(result.outputFiles?.map((f) => f.name)).toEqual([
      'output.txt',
      'output_2.txt',
    ]);
    expect(await fs.readFile(path.join(tempDir, 'output.txt'), 'utf8')).toBe(
      'first',
    );
    expect(await fs.readFile(path.join(tempDir, 'output_2.txt'), 'utf8')).toBe(
      'second',
    );
  });

  it('reports an output name escaping the configured directory as an execution error', async () => {
    // Nested so the escape target stays inside this test's own temp tree.
    const outputDir = path.join(tempDir, 'out');
    const toolset = new SkillToolset([mockSkill], {
      codeExecutor: new MockCodeExecutor([
        textFile('../escape.txt', 'dangerous'),
      ]),
      outputDir,
    });

    const result = await runScript(toolset);

    expect(result).toEqual({
      error: expect.stringMatching(/Path traversal detected/),
      errorCode: 'EXECUTION_ERROR',
    });
    await expect(fs.access(path.join(tempDir, 'escape.txt'))).rejects.toThrow(
      /ENOENT/,
    );
  });
});
