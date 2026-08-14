/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type {
  CodeExecutionResult,
  SessionArtifactService,
  SkillScriptResponse,
} from '@google/adk';
import {
  CodeExecutionLanguage,
  Context,
  createSession,
  InvocationContext,
  LlmAgent,
  PluginManager,
  RunSkillInlineScriptTool,
  SkillToolset,
  ToolConfirmation,
  UnsafeLocalCodeExecutor,
} from '@google/adk';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {afterEach, describe, expect, it} from 'vitest';
import {
  createSessionArtifactService,
  loadArtifactText,
} from './artifact_service_test_utils.js';

/** Content written by the output-file scripts under test. */
const FILE_CONTENT = 'hello from output file';

const IS_WINDOWS = os.platform() === 'win32';
const IS_UNIX = os.platform() === 'linux' || os.platform() === 'darwin';

// Cold-starting a separate interpreter on the windows-latest CI runner can
// exceed vitest's 5000ms default; the Python cases below have timed out there.
// Applied to every case that leaves the already-resident node binary. Must also
// exceed UnsafeLocalCodeExecutor's default timeoutSeconds (30) so the executor's
// own timeout error surfaces first; see
// core/src/code_executors/unsafe_local_code_executor.ts
const TEST_EXECUTION_TIMEOUT = 40000;

describe('RunSkillInlineScriptTool Integration with UnsafeLocalCodeExecutor', () => {
  const scratchDirs: string[] = [];

  async function makeOutputDir(): Promise<string> {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'adk-inline-out-'));
    scratchDirs.push(dir);
    return dir;
  }

  afterEach(async () => {
    while (scratchDirs.length > 0) {
      await fs.rm(scratchDirs.pop()!, {recursive: true, force: true});
    }
  });

  // These integration tests exercise real code execution, which is gated behind
  // a human-in-the-loop confirmation. Supply an already-confirmed confirmation
  // so the tool proceeds to execute (see run_skill_inline_script_tool.ts).
  function createMockContext(
    agentName = 'test-agent',
    artifactService?: SessionArtifactService,
  ) {
    const invocationContext = new InvocationContext({
      invocationId: 'test-invocation',
      agent: new LlmAgent({name: agentName}),
      session: createSession({id: 'test-session', appName: 'test-app'}),
      pluginManager: new PluginManager([]),
      artifactService,
    });

    return new Context({
      invocationContext,
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

  /**
   * Registers a directory the tool chose for removal. Asserting containment
   * before registering keeps a wrong `outputDir` a test failure rather than a
   * recursive delete of whatever the tool named.
   */
  function trackToolOutputDir(dir: string | undefined): asserts dir is string {
    if (dir === undefined) {
      expect.fail('expected an outputDir on the tool result');
    }
    expect(path.dirname(dir)).toBe(os.tmpdir());
    scratchDirs.push(dir);
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

  // A shell interpreter cold start is slow on CI, so these cases pass an
  // explicit timeout instead of the project default.
  it.skipIf(!IS_UNIX)(
    'successfully executes a real Shell inline script',
    async () => {
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
    },
    TEST_EXECUTION_TIMEOUT,
  );

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

  it.skipIf(!IS_UNIX)(
    'captures stderr and exit code from a real Shell inline script',
    async () => {
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
    },
    TEST_EXECUTION_TIMEOUT,
  );

  it.skipIf(!IS_WINDOWS)(
    'successfully executes a real PowerShell inline script',
    async () => {
      const executor = new UnsafeLocalCodeExecutor();
      const toolset = new SkillToolset([], {codeExecutor: executor});
      const tool = new RunSkillInlineScriptTool(toolset);

      const result = (await tool.runAsync({
        args: {
          script_content: 'Write-Host "hello from real powershell"',
          language: CodeExecutionLanguage.POWERSHELL,
        },
        toolContext: createMockContext(),
      })) as CodeExecutionResult;

      expect(result).toBeDefined();
      expect(result.stdout).toContain('hello from real powershell');
      expect(result.stderr).toBe('');
    },
    TEST_EXECUTION_TIMEOUT,
  );

  it.skipIf(!IS_WINDOWS)(
    'captures stderr from a failing PowerShell inline script',
    async () => {
      const executor = new UnsafeLocalCodeExecutor();
      const toolset = new SkillToolset([], {codeExecutor: executor});
      const tool = new RunSkillInlineScriptTool(toolset);

      const result = (await tool.runAsync({
        args: {
          script_content: 'Write-Error "some powershell error"; exit 1',
          language: CodeExecutionLanguage.POWERSHELL,
        },
        toolContext: createMockContext(),
      })) as CodeExecutionResult;

      expect(result).toBeDefined();
      // PowerShell wraps Write-Error output at the console width, and the long
      // temp script path pushes the message across the break, so assert the
      // distinctive fragment rather than the whole message.
      expect(result.stderr).toContain('powershell error');
    },
    TEST_EXECUTION_TIMEOUT,
  );

  it.skipIf(!IS_WINDOWS)(
    'successfully executes a real CMD inline script',
    async () => {
      const executor = new UnsafeLocalCodeExecutor();
      const toolset = new SkillToolset([], {codeExecutor: executor});
      const tool = new RunSkillInlineScriptTool(toolset);

      const result = (await tool.runAsync({
        args: {
          script_content: '@echo off\necho hello from real cmd',
          language: CodeExecutionLanguage.WINDOWS_CMD,
        },
        toolContext: createMockContext(),
      })) as CodeExecutionResult;

      expect(result).toBeDefined();
      expect(result.stdout).toContain('hello from real cmd');
      expect(result.stderr).toBe('');
    },
    TEST_EXECUTION_TIMEOUT,
  );

  it.skipIf(!IS_WINDOWS)(
    'captures stderr from a failing CMD inline script',
    async () => {
      const executor = new UnsafeLocalCodeExecutor();
      const toolset = new SkillToolset([], {codeExecutor: executor});
      const tool = new RunSkillInlineScriptTool(toolset);

      const result = (await tool.runAsync({
        args: {
          script_content: '@echo off\n>&2 echo some cmd error\nexit /b 1',
          language: CodeExecutionLanguage.WINDOWS_CMD,
        },
        toolContext: createMockContext(),
      })) as CodeExecutionResult;

      expect(result).toBeDefined();
      expect(result.stderr).toContain('some cmd error');
    },
    TEST_EXECUTION_TIMEOUT,
  );

  it(
    'successfully executes a real Python inline script',
    async () => {
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
    },
    TEST_EXECUTION_TIMEOUT,
  );

  it(
    'captures stderr from a real Python inline script',
    async () => {
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
    },
    TEST_EXECUTION_TIMEOUT,
  );

  it('writes output files into the configured outputDir', async () => {
    const outputDir = await makeOutputDir();
    const executor = new UnsafeLocalCodeExecutor();
    const toolset = new SkillToolset([], {codeExecutor: executor, outputDir});
    const tool = new RunSkillInlineScriptTool(toolset);

    const testFileName = `test_output_${Date.now()}.txt`;
    const testFileContent = 'hello from output file';

    const result = (await tool.runAsync({
      args: {
        script_content: `const fs = require('fs'); fs.writeFileSync('${testFileName}', '${testFileContent}');`,
        language: CodeExecutionLanguage.JAVASCRIPT,
      },
      toolContext: createMockContext(),
    })) as SkillScriptResponse;

    expect(result.outputDir).toBe(outputDir);
    expect(result.outputFiles?.map((f) => f.name)).toContain(testFileName);

    const content = await fs.readFile(
      path.join(outputDir, testFileName),
      'utf-8',
    );
    expect(content).toBe(testFileContent);

    await expect(
      fs.access(path.join(process.cwd(), testFileName)),
    ).rejects.toThrow(/ENOENT/);
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
    const outputDir = await makeOutputDir();
    const executor = new UnsafeLocalCodeExecutor();
    const toolset = new SkillToolset([], {codeExecutor: executor, outputDir});
    const tool = new RunSkillInlineScriptTool(toolset);

    const testFileName = `test_inline_output_${Date.now()}.txt`;
    const testFileContent = 'hello from output file';

    // Pre-create the target file to force a collision
    await fs.writeFile(path.join(outputDir, testFileName), 'existing content');

    const result = (await tool.runAsync({
      args: {
        script_content: `const fs = require('fs'); fs.writeFileSync('${testFileName}', '${testFileContent}');`,
        language: CodeExecutionLanguage.JAVASCRIPT,
      },
      toolContext: createMockContext(),
    })) as SkillScriptResponse;

    const expectedName = `${path.basename(testFileName, '.txt')}_2.txt`;
    expect(result.outputFiles?.map((f) => f.name)).toContain(expectedName);

    const content = await fs.readFile(
      path.join(outputDir, expectedName),
      'utf-8',
    );
    expect(content).toBe(testFileContent);
  });
  it('saves script output files to the artifact service', async () => {
    const executor = new UnsafeLocalCodeExecutor();
    const toolset = new SkillToolset([], {codeExecutor: executor});
    const tool = new RunSkillInlineScriptTool(toolset);
    const artifactService = createSessionArtifactService();
    const toolContext = createMockContext('test-agent', artifactService);
    const testFileName = `test_output_${Date.now()}.txt`;

    const result = (await tool.runAsync({
      args: {
        script_content: writeFileScript(testFileName),
        language: CodeExecutionLanguage.JAVASCRIPT,
      },
      toolContext,
    })) as SkillScriptResponse;
    trackToolOutputDir(result.outputDir);

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
    trackToolOutputDir(result.outputDir);

    expect(result.outputFiles).toEqual([
      {name: testFileName, mimeType: 'text/plain'},
    ]);
    expect(result.warning).toMatch(/No artifact service is configured/);
    expect(await cwdContains(testFileName)).toBe(false);
  });

  it('creates a new artifact version instead of a renamed file on repeat runs', async () => {
    const executor = new UnsafeLocalCodeExecutor();
    const toolset = new SkillToolset([], {codeExecutor: executor});
    const tool = new RunSkillInlineScriptTool(toolset);
    const artifactService = createSessionArtifactService();
    const testFileName = `test_inline_artifact_${Date.now()}.txt`;
    const args = {
      script_content: writeFileScript(testFileName),
      language: CodeExecutionLanguage.JAVASCRIPT,
    };

    const first = (await tool.runAsync({
      args,
      toolContext: createMockContext('test-agent', artifactService),
    })) as SkillScriptResponse;
    trackToolOutputDir(first.outputDir);
    const result = (await tool.runAsync({
      args,
      toolContext: createMockContext('test-agent', artifactService),
    })) as SkillScriptResponse;
    trackToolOutputDir(result.outputDir);

    expect(result.outputFiles).toEqual([
      {name: testFileName, mimeType: 'text/plain'},
    ]);
    expect(await artifactService.listVersions(testFileName)).toEqual([0, 1]);
    // Each run without a configured outputDir gets a directory of its own, so
    // the second run collides with nothing and no file is renamed.
    const collisionName = `${path.basename(testFileName, '.txt')}_2.txt`;
    expect(await cwdContains(collisionName)).toBe(false);
  });
});
