/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  CodeExecutionLanguage,
  CodeExecutionResult,
  Context,
  InvocationContext,
  RunSkillInlineScriptTool,
  SkillToolset,
  ToolConfirmation,
  UnsafeLocalCodeExecutor,
} from '@google/adk';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {describe, expect, it} from 'vitest';

describe('RunSkillInlineScriptTool Integration with UnsafeLocalCodeExecutor', () => {
  // These integration tests exercise real code execution, which is gated behind
  // a human-in-the-loop confirmation. Supply an already-confirmed confirmation
  // so the tool proceeds to execute (see run_skill_inline_script_tool.ts).
  function createMockContext(agentName = 'test-agent') {
    return new Context({
      invocationContext: {
        session: {state: {}},
        agent: {name: agentName},
      } as unknown as InvocationContext,
      toolConfirmation: new ToolConfirmation({confirmed: true}),
    });
  }

  it('successfully executes a real JavaScript inline script', async () => {
    const executor = new UnsafeLocalCodeExecutor();
    const toolset = new SkillToolset([], {codeExecutor: executor});
    const tool = new RunSkillInlineScriptTool(toolset);

    const result = (await tool.runAsync({
      args: {
        script_content: 'console.log("hello from real js");',
        language: CodeExecutionLanguage.JAVASCRIPT,
      },
      toolContext: createMockContext(),
    })) as CodeExecutionResult;

    expect(result).toBeDefined();
    expect(result.stdout).toContain('hello from real js');
    expect(result.stderr).toBe('');
  });

  it('successfully executes a real Shell inline script', async () => {
    const executor = new UnsafeLocalCodeExecutor();
    const toolset = new SkillToolset([], {codeExecutor: executor});
    const tool = new RunSkillInlineScriptTool(toolset);

    const result = (await tool.runAsync({
      args: {
        script_content: 'echo "hello from real sh"',
        language: CodeExecutionLanguage.SHELL,
      },
      toolContext: createMockContext(),
    })) as CodeExecutionResult;

    expect(result).toBeDefined();
    expect(result.stdout).toContain('hello from real sh');
    expect(result.stderr).toBe('');
  });

  it('captures stderr from a real JavaScript inline script', async () => {
    const executor = new UnsafeLocalCodeExecutor();
    const toolset = new SkillToolset([], {codeExecutor: executor});
    const tool = new RunSkillInlineScriptTool(toolset);

    const result = (await tool.runAsync({
      args: {
        script_content: 'console.error("some js error"); process.exit(1);',
        language: CodeExecutionLanguage.JAVASCRIPT,
      },
      toolContext: createMockContext(),
    })) as CodeExecutionResult;

    expect(result).toBeDefined();
    expect(result.stderr).toContain('some js error');
  });

  it('captures stderr and exit code from a real Shell inline script', async () => {
    const executor = new UnsafeLocalCodeExecutor();
    const toolset = new SkillToolset([], {codeExecutor: executor});
    const tool = new RunSkillInlineScriptTool(toolset);

    const result = (await tool.runAsync({
      args: {
        script_content: '>&2 echo "some sh error"; exit 2',
        language: CodeExecutionLanguage.SHELL,
      },
      toolContext: createMockContext(),
    })) as CodeExecutionResult;

    expect(result).toBeDefined();
    expect(result.stderr).toContain('some sh error');
  });

  it('successfully executes a real Python inline script', async () => {
    const executor = new UnsafeLocalCodeExecutor();
    const toolset = new SkillToolset([], {codeExecutor: executor});
    const tool = new RunSkillInlineScriptTool(toolset);

    const result = (await tool.runAsync({
      args: {
        script_content: 'print("hello from real python")',
        language: CodeExecutionLanguage.PYTHON,
      },
      toolContext: createMockContext(),
    })) as CodeExecutionResult;

    expect(result).toBeDefined();
    expect(result.stdout).toContain('hello from real python');
    expect(result.stderr).toBe('');
  });

  it('captures stderr from a real Python inline script', async () => {
    const executor = new UnsafeLocalCodeExecutor();
    const toolset = new SkillToolset([], {codeExecutor: executor});
    const tool = new RunSkillInlineScriptTool(toolset);

    const result = (await tool.runAsync({
      args: {
        script_content:
          'import sys; sys.stderr.write("some python error\\n"); sys.exit(1)',
        language: CodeExecutionLanguage.PYTHON,
      },
      toolContext: createMockContext(),
    })) as CodeExecutionResult;

    expect(result).toBeDefined();
    expect(result.stderr).toContain('some python error');
  });

  it('returns output files inline without writing to disk when no output directory is configured', async () => {
    const executor = new UnsafeLocalCodeExecutor();
    const toolset = new SkillToolset([], {codeExecutor: executor});
    const tool = new RunSkillInlineScriptTool(toolset);

    const testFileName = `test_output_${Date.now()}.txt`;
    const testFileContent = 'hello from output file';

    const result = (await tool.runAsync({
      args: {
        script_content: `const fs = require('fs'); fs.writeFileSync('${testFileName}', '${testFileContent}');`,
        language: CodeExecutionLanguage.JAVASCRIPT,
      },
      toolContext: createMockContext(),
    })) as CodeExecutionResult;

    const outputFile = result.outputFiles?.find((f) => f.name === testFileName);
    if (!outputFile) {
      expect.fail(`expected ${testFileName} on the tool result`);
    }
    expect(
      Buffer.from(outputFile.content, outputFile.contentEncoding).toString(
        'utf8',
      ),
    ).toBe(testFileContent);

    await expect(
      fs.access(path.join(process.cwd(), testFileName)),
    ).rejects.toThrow(/ENOENT/);
  });

  it('creates files in the configured output directory', async () => {
    const outputDir = await fs.mkdtemp(
      path.join(os.tmpdir(), 'adk-skill-output-'),
    );
    const executor = new UnsafeLocalCodeExecutor();
    const toolset = new SkillToolset([], {codeExecutor: executor, outputDir});
    const tool = new RunSkillInlineScriptTool(toolset);

    const testFileName = `test_output_${Date.now()}.txt`;
    const testFileContent = 'hello from output file';

    try {
      const result = (await tool.runAsync({
        args: {
          script_content: `const fs = require('fs'); fs.writeFileSync('${testFileName}', '${testFileContent}');`,
          language: CodeExecutionLanguage.JAVASCRIPT,
        },
        toolContext: createMockContext(),
      })) as CodeExecutionResult;

      const outputFile = result.outputFiles?.find(
        (f) => f.name === testFileName,
      );
      expect(outputFile).toBeDefined();

      const content = await fs.readFile(
        path.join(outputDir, testFileName),
        'utf-8',
      );
      expect(content).toBe(testFileContent);

      // The launch directory must stay clean.
      await expect(
        fs.access(path.join(process.cwd(), testFileName)),
      ).rejects.toThrow(/ENOENT/);
    } finally {
      await fs.rm(outputDir, {recursive: true, force: true});
      // A regression writes to the launch directory instead; remove it so a
      // failing run does not leave the working tree dirty.
      await fs.rm(path.join(process.cwd(), testFileName), {force: true});
    }
  });

  it('successfully passes array arguments to a JavaScript inline script', async () => {
    const executor = new UnsafeLocalCodeExecutor();
    const toolset = new SkillToolset([], {codeExecutor: executor});
    const tool = new RunSkillInlineScriptTool(toolset);

    const result = (await tool.runAsync({
      args: {
        script_content: 'console.log(process.argv.slice(2).join(" "));',
        language: CodeExecutionLanguage.JAVASCRIPT,
        args: ['arg1', 'arg2'],
      },
      toolContext: createMockContext(),
    })) as CodeExecutionResult;

    expect(result).toBeDefined();
    expect(result.stdout).toContain('arg1 arg2');
  });

  it('successfully passes object arguments to a JavaScript inline script', async () => {
    const executor = new UnsafeLocalCodeExecutor();
    const toolset = new SkillToolset([], {codeExecutor: executor});
    const tool = new RunSkillInlineScriptTool(toolset);

    const result = (await tool.runAsync({
      args: {
        script_content: 'console.log(process.argv.slice(2).join(" "));',
        language: CodeExecutionLanguage.JAVASCRIPT,
        args: {flag1: 'val1', flag2: 'val2'},
      },
      toolContext: createMockContext(),
    })) as CodeExecutionResult;

    expect(result).toBeDefined();
    expect(result.stdout).toContain('--flag1 val1 --flag2 val2');
  });

  it('handles file collisions by appending a numeric suffix', async () => {
    const outputDir = await fs.mkdtemp(
      path.join(os.tmpdir(), 'adk-skill-output-'),
    );
    const executor = new UnsafeLocalCodeExecutor();
    const toolset = new SkillToolset([], {codeExecutor: executor, outputDir});
    const tool = new RunSkillInlineScriptTool(toolset);

    const testFileName = `test_inline_output_${Date.now()}.txt`;
    const testFileContent = 'hello from output file';

    try {
      // Pre-create the target file to force a collision.
      await fs.writeFile(
        path.join(outputDir, testFileName),
        'existing content',
      );

      const result = (await tool.runAsync({
        args: {
          script_content: `const fs = require('fs'); fs.writeFileSync('${testFileName}', '${testFileContent}');`,
          language: CodeExecutionLanguage.JAVASCRIPT,
        },
        toolContext: createMockContext(),
      })) as CodeExecutionResult;

      const expectedName = `${path.basename(testFileName, '.txt')}_2.txt`;
      const outputFile = result.outputFiles?.find(
        (f) => f.name === expectedName,
      );
      expect(outputFile).toBeDefined();

      const content = await fs.readFile(
        path.join(outputDir, expectedName),
        'utf-8',
      );
      expect(content).toBe(testFileContent);

      await expect(
        fs.access(path.join(process.cwd(), expectedName)),
      ).rejects.toThrow(/ENOENT/);
    } finally {
      await fs.rm(outputDir, {recursive: true, force: true});
    }
  });
});
