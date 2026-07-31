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
  SessionArtifactService,
  SkillScriptResponse,
  SkillToolset,
  ToolConfirmation,
  UnsafeLocalCodeExecutor,
} from '@google/adk';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import {describe, expect, it} from 'vitest';
import {
  loadArtifactText,
  SessionScopedInMemoryArtifactService,
} from './artifact_service_test_utils.js';

/** Content written by the output-file scripts under test. */
const FILE_CONTENT = 'hello from output file';

describe('RunSkillInlineScriptTool Integration with UnsafeLocalCodeExecutor', () => {
  // These integration tests exercise real code execution, which is gated behind
  // a human-in-the-loop confirmation. Supply an already-confirmed confirmation
  // so the tool proceeds to execute (see run_skill_inline_script_tool.ts).
  function createMockContext(
    agentName = 'test-agent',
    artifactService?: SessionArtifactService,
  ) {
    return new Context({
      invocationContext: {
        session: {state: {}},
        agent: {name: agentName},
        artifactService,
      } as unknown as InvocationContext,
      toolConfirmation: new ToolConfirmation({confirmed: true}),
    });
  }

  async function cwdContains(filename: string): Promise<boolean> {
    return fs
      .access(path.join(process.cwd(), filename))
      .then(() => true)
      .catch(() => false);
  }

  /** A script that writes `hello from output file` to the given filename. */
  function writeFileScript(filename: string): string {
    return `const fs = require('fs'); fs.writeFileSync('${filename}', '${FILE_CONTENT}');`;
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

  it('saves script output files to the artifact service', async () => {
    const executor = new UnsafeLocalCodeExecutor();
    const toolset = new SkillToolset([], {codeExecutor: executor});
    const tool = new RunSkillInlineScriptTool(toolset);
    const artifactService = new SessionScopedInMemoryArtifactService();
    const toolContext = createMockContext('test-agent', artifactService);
    const testFileName = `test_output_${Date.now()}.txt`;

    const result = (await tool.runAsync({
      args: {
        script_content: writeFileScript(testFileName),
        language: CodeExecutionLanguage.JAVASCRIPT,
      },
      toolContext,
    })) as SkillScriptResponse;

    expect(result.outputFiles).toEqual([
      {name: testFileName, mimeType: 'text/plain'},
    ]);
    expect(result.warning).toBeUndefined();
    expect(await loadArtifactText(artifactService, testFileName)).toBe(
      FILE_CONTENT,
    );
    expect(toolContext.actions.artifactDelta).toEqual({[testFileName]: 0});
    expect(await cwdContains(testFileName)).toBe(false);
  });

  it('reports output files with a warning when no artifact service is configured', async () => {
    const executor = new UnsafeLocalCodeExecutor();
    const toolset = new SkillToolset([], {codeExecutor: executor});
    const tool = new RunSkillInlineScriptTool(toolset);
    const testFileName = `test_unsaved_output_${Date.now()}.txt`;

    const result = (await tool.runAsync({
      args: {
        script_content: writeFileScript(testFileName),
        language: CodeExecutionLanguage.JAVASCRIPT,
      },
      toolContext: createMockContext(),
    })) as SkillScriptResponse;

    expect(result.outputFiles).toEqual([
      {name: testFileName, mimeType: 'text/plain'},
    ]);
    expect(result.warning).toMatch(/No artifact service is configured/);
    expect(await cwdContains(testFileName)).toBe(false);
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

  it('creates a new artifact version instead of a renamed file on repeat runs', async () => {
    const executor = new UnsafeLocalCodeExecutor();
    const toolset = new SkillToolset([], {codeExecutor: executor});
    const tool = new RunSkillInlineScriptTool(toolset);
    const artifactService = new SessionScopedInMemoryArtifactService();
    const testFileName = `test_inline_output_${Date.now()}.txt`;
    const args = {
      script_content: writeFileScript(testFileName),
      language: CodeExecutionLanguage.JAVASCRIPT,
    };

    await tool.runAsync({
      args,
      toolContext: createMockContext('test-agent', artifactService),
    });
    const result = (await tool.runAsync({
      args,
      toolContext: createMockContext('test-agent', artifactService),
    })) as SkillScriptResponse;

    expect(result.outputFiles).toEqual([
      {name: testFileName, mimeType: 'text/plain'},
    ]);
    expect(await artifactService.listVersions(testFileName)).toEqual([0, 1]);
    const collisionName = `${path.basename(testFileName, '.txt')}_2.txt`;
    expect(await cwdContains(collisionName)).toBe(false);
  });
});
