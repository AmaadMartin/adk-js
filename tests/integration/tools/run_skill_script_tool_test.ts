/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  CodeExecutionResult,
  Context,
  InvocationContext,
  RunSkillScriptTool,
  Skill,
  SkillScriptResult,
  SkillToolset,
  UnsafeLocalCodeExecutor,
} from '@google/adk';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {afterEach, describe, expect, it} from 'vitest';

const IS_WINDOWS = os.platform() === 'win32';
const IS_UNIX = os.platform() === 'linux' || os.platform() === 'darwin';

// PowerShell/cmd cold-start on the windows-latest CI runner can exceed vitest's
// 5000ms default. Must also exceed UnsafeLocalCodeExecutor's default
// timeoutSeconds (30) so the executor's own timeout error surfaces first; see
// core/src/code_executors/unsafe_local_code_executor.ts
const TEST_EXECUTION_TIMEOUT = 40000;

describe('RunSkillScriptTool Integration with UnsafeLocalCodeExecutor', () => {
  const scratchDirs: string[] = [];

  async function makeOutputDir(): Promise<string> {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'adk-script-out-'));
    scratchDirs.push(dir);
    return dir;
  }

  /**
   * Registers a directory the tool chose for removal. Asserting containment
   * before registering keeps a wrong `outputDir` a test failure rather than a
   * recursive delete of whatever the tool named.
   */
  function trackToolOutputDir(dir: string): void {
    expect(path.dirname(dir)).toBe(os.tmpdir());
    scratchDirs.push(dir);
  }

  afterEach(async () => {
    while (scratchDirs.length > 0) {
      await fs.rm(scratchDirs.pop()!, {recursive: true, force: true});
    }
  });

  function createMockContext(agentName = 'test-agent') {
    return new Context({
      invocationContext: {
        session: {state: {}},
        agent: {name: agentName},
      } as unknown as InvocationContext,
    });
  }

  const testSkill: Skill = {
    frontmatter: {
      name: 'test-skill',
      description: 'A mock skill for integration tests',
    },
    instructions: 'Run scripts.',
    resources: {
      scripts: {
        'hello.js': {
          src: 'console.log("hello from skill js");',
        },
        'hello.sh': {
          src: 'echo "hello from skill sh"',
        },
        'fail.js': {
          src: 'console.error("skill js error"); process.exit(1);',
        },
        'fail.sh': {
          src: '>&2 echo "skill sh error"; exit 2',
        },
        'hello.py': {
          src: 'print("hello from skill python")',
        },
        'fail.py': {
          src: 'import sys; sys.stderr.write("skill python error\\n"); sys.exit(1)',
        },
        'create_file.js': {
          src: "const fs = require('fs'); fs.writeFileSync('output_from_script.txt', 'hello from script file');",
        },
        'hello.ps1': {
          src: 'Write-Host "hello from skill powershell"',
        },
        'hello.bat': {
          src: '@echo off\necho hello from skill cmd',
        },
        'fail.ps1': {
          src: 'Write-Error "skill powershell error"; exit 1',
        },
        'fail.bat': {
          src: '@echo off\n>&2 echo skill cmd error\nexit /b 1',
        },
      },
    },
  };

  it('successfully executes a real JavaScript skill script', async () => {
    const executor = new UnsafeLocalCodeExecutor();
    const toolset = new SkillToolset([testSkill], {codeExecutor: executor});
    const tool = new RunSkillScriptTool(toolset);

    const result = (await tool.runAsync({
      args: {
        skill_name: 'test-skill',
        script_path: 'scripts/hello.js',
      },
      toolContext: createMockContext(),
    })) as CodeExecutionResult;

    expect(result).toBeDefined();
    expect(result.stdout).toContain('hello from skill js');
    expect(result.stderr).toBe('');
  });

  it.skipIf(!IS_UNIX)(
    'successfully executes a real Shell skill script',
    async () => {
      const executor = new UnsafeLocalCodeExecutor();
      const toolset = new SkillToolset([testSkill], {codeExecutor: executor});
      const tool = new RunSkillScriptTool(toolset);

      const result = (await tool.runAsync({
        args: {
          skill_name: 'test-skill',
          script_path: 'scripts/hello.sh',
        },
        toolContext: createMockContext(),
      })) as CodeExecutionResult;

      expect(result).toBeDefined();
      expect(result.stdout).toContain('hello from skill sh');
      expect(result.stderr).toBe('');
    },
  );

  it('captures stderr from a failing JavaScript skill script', async () => {
    const executor = new UnsafeLocalCodeExecutor();
    const toolset = new SkillToolset([testSkill], {codeExecutor: executor});
    const tool = new RunSkillScriptTool(toolset);

    const result = (await tool.runAsync({
      args: {
        skill_name: 'test-skill',
        script_path: 'scripts/fail.js',
      },
      toolContext: createMockContext(),
    })) as CodeExecutionResult;

    expect(result).toBeDefined();
    expect(result.stderr).toContain('skill js error');
  });

  it.skipIf(!IS_UNIX)(
    'captures stderr and exit code from a failing Shell skill script',
    async () => {
      const executor = new UnsafeLocalCodeExecutor();
      const toolset = new SkillToolset([testSkill], {codeExecutor: executor});
      const tool = new RunSkillScriptTool(toolset);

      const result = (await tool.runAsync({
        args: {
          skill_name: 'test-skill',
          script_path: 'scripts/fail.sh',
        },
        toolContext: createMockContext(),
      })) as CodeExecutionResult;

      expect(result).toBeDefined();
      expect(result.stderr).toContain('skill sh error');
    },
  );

  it('successfully executes a real Python skill script', async () => {
    const executor = new UnsafeLocalCodeExecutor();
    const toolset = new SkillToolset([testSkill], {codeExecutor: executor});
    const tool = new RunSkillScriptTool(toolset);

    const result = (await tool.runAsync({
      args: {
        skill_name: 'test-skill',
        script_path: 'scripts/hello.py',
      },
      toolContext: createMockContext(),
    })) as CodeExecutionResult;

    expect(result).toBeDefined();
    expect(result.stdout).toContain('hello from skill python');
    expect(result.stderr).toBe('');
  });

  it('captures stderr from a failing Python skill script', async () => {
    const executor = new UnsafeLocalCodeExecutor();
    const toolset = new SkillToolset([testSkill], {codeExecutor: executor});
    const tool = new RunSkillScriptTool(toolset);

    const result = (await tool.runAsync({
      args: {
        skill_name: 'test-skill',
        script_path: 'scripts/fail.py',
      },
      toolContext: createMockContext(),
    })) as CodeExecutionResult;

    expect(result).toBeDefined();
    expect(result.stderr).toContain('skill python error');
  });

  it.skipIf(!IS_WINDOWS)(
    'successfully executes a real PowerShell skill script',
    async () => {
      const executor = new UnsafeLocalCodeExecutor();
      const toolset = new SkillToolset([testSkill], {codeExecutor: executor});
      const tool = new RunSkillScriptTool(toolset);

      const result = (await tool.runAsync({
        args: {
          skill_name: 'test-skill',
          script_path: 'scripts/hello.ps1',
        },
        toolContext: createMockContext(),
      })) as CodeExecutionResult;

      expect(result).toBeDefined();
      expect(result.stdout).toContain('hello from skill powershell');
      expect(result.stderr).toBe('');
    },
    TEST_EXECUTION_TIMEOUT,
  );

  it.skipIf(!IS_WINDOWS)(
    'captures stderr from a failing PowerShell skill script',
    async () => {
      const executor = new UnsafeLocalCodeExecutor();
      const toolset = new SkillToolset([testSkill], {codeExecutor: executor});
      const tool = new RunSkillScriptTool(toolset);

      const result = (await tool.runAsync({
        args: {
          skill_name: 'test-skill',
          script_path: 'scripts/fail.ps1',
        },
        toolContext: createMockContext(),
      })) as CodeExecutionResult;

      expect(result).toBeDefined();
      expect(result.stderr).toContain('skill');
      expect(result.stderr).toContain('powershell error');
    },
    TEST_EXECUTION_TIMEOUT,
  );

  it.skipIf(!IS_WINDOWS)(
    'successfully executes a real CMD skill script',
    async () => {
      const executor = new UnsafeLocalCodeExecutor();
      const toolset = new SkillToolset([testSkill], {codeExecutor: executor});
      const tool = new RunSkillScriptTool(toolset);

      const result = (await tool.runAsync({
        args: {
          skill_name: 'test-skill',
          script_path: 'scripts/hello.bat',
        },
        toolContext: createMockContext(),
      })) as CodeExecutionResult;

      expect(result).toBeDefined();
      expect(result.stdout).toContain('hello from skill cmd');
      expect(result.stderr).toBe('');
    },
    TEST_EXECUTION_TIMEOUT,
  );

  it.skipIf(!IS_WINDOWS)(
    'captures stderr from a failing CMD skill script',
    async () => {
      const executor = new UnsafeLocalCodeExecutor();
      const toolset = new SkillToolset([testSkill], {codeExecutor: executor});
      const tool = new RunSkillScriptTool(toolset);

      const result = (await tool.runAsync({
        args: {
          skill_name: 'test-skill',
          script_path: 'scripts/fail.bat',
        },
        toolContext: createMockContext(),
      })) as CodeExecutionResult;

      expect(result).toBeDefined();
      expect(result.stderr).toContain('skill cmd error');
    },
    TEST_EXECUTION_TIMEOUT,
  );

  it('writes output files into the configured outputDir', async () => {
    const outputDir = await makeOutputDir();
    const executor = new UnsafeLocalCodeExecutor();
    const toolset = new SkillToolset([testSkill], {
      codeExecutor: executor,
      outputDir,
    });
    const tool = new RunSkillScriptTool(toolset);

    const result = (await tool.runAsync({
      args: {
        skill_name: 'test-skill',
        script_path: 'scripts/create_file.js',
      },
      toolContext: createMockContext(),
    })) as SkillScriptResult;

    expect(result.outputDir).toBe(outputDir);
    expect(result.outputFiles?.map((f) => f.name)).toContain(
      'output_from_script.txt',
    );

    const content = await fs.readFile(
      path.join(outputDir, 'output_from_script.txt'),
      'utf-8',
    );
    expect(content).toBe('hello from script file');

    await expect(
      fs.access(path.join(process.cwd(), 'output_from_script.txt')),
    ).rejects.toThrow(/ENOENT/);
  });

  it('does not write output files into the working directory by default', async () => {
    const executor = new UnsafeLocalCodeExecutor();
    const toolset = new SkillToolset([testSkill], {codeExecutor: executor});
    const tool = new RunSkillScriptTool(toolset);

    const result = (await tool.runAsync({
      args: {
        skill_name: 'test-skill',
        script_path: 'scripts/create_file.js',
      },
      toolContext: createMockContext(),
    })) as SkillScriptResult;

    if (!result.outputDir) {
      expect.fail('expected an outputDir on the tool result');
    }
    trackToolOutputDir(result.outputDir);

    await expect(
      fs.access(path.join(process.cwd(), 'output_from_script.txt')),
    ).rejects.toThrow(/ENOENT/);

    const content = await fs.readFile(
      path.join(result.outputDir, 'output_from_script.txt'),
      'utf-8',
    );
    expect(content).toBe('hello from script file');
  });

  it('handles file collisions by appending a numeric suffix', async () => {
    const outputDir = await makeOutputDir();
    const executor = new UnsafeLocalCodeExecutor();
    const toolset = new SkillToolset([testSkill], {
      codeExecutor: executor,
      outputDir,
    });
    const tool = new RunSkillScriptTool(toolset);

    // Pre-create the target file to force a collision
    await fs.writeFile(
      path.join(outputDir, 'output_from_script.txt'),
      'existing content',
    );

    const result = (await tool.runAsync({
      args: {
        skill_name: 'test-skill',
        script_path: 'scripts/create_file.js',
      },
      toolContext: createMockContext(),
    })) as SkillScriptResult;

    expect(result.outputFiles?.map((f) => f.name)).toContain(
      'output_from_script_2.txt',
    );

    const content = await fs.readFile(
      path.join(outputDir, 'output_from_script_2.txt'),
      'utf-8',
    );
    expect(content).toBe('hello from script file');
  });
});
