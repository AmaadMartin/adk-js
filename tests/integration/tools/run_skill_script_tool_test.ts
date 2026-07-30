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
  SkillToolset,
  UnsafeLocalCodeExecutor,
} from '@google/adk';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';

const IS_WINDOWS = os.platform() === 'win32';
const IS_UNIX = os.platform() === 'linux' || os.platform() === 'darwin';

describe('RunSkillScriptTool Integration with UnsafeLocalCodeExecutor', () => {
  // RunSkillScriptTool materializes a script's output files into process.cwd()
  // (see materializeFiles in core/src/utils/file_utils.ts), which is the repo
  // root when the suite runs. Run every test from a throwaway directory so that
  // a failed assertion can never leave a generated file in the working tree,
  // and so the deterministic filename the collision test relies on cannot be
  // poisoned by a previous run.
  let originalCwd: string;
  let workDir: string;

  beforeEach(async () => {
    originalCwd = process.cwd();
    workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'adk-run-skill-script-'));
    process.chdir(workDir);
  });

  afterEach(async () => {
    // Restore the cwd first so a removal failure cannot strand the worker in a
    // deleted directory, and so Windows does not refuse to remove a directory
    // that is a live process's cwd.
    process.chdir(originalCwd);
    await fs.rm(workDir, {recursive: true, force: true});
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
  );

  it('creates files in process.cwd returned from execution', async () => {
    const executor = new UnsafeLocalCodeExecutor();
    const toolset = new SkillToolset([testSkill], {codeExecutor: executor});
    const tool = new RunSkillScriptTool(toolset);

    const result = (await tool.runAsync({
      args: {
        skill_name: 'test-skill',
        script_path: 'scripts/create_file.js',
      },
      toolContext: createMockContext(),
    })) as CodeExecutionResult;

    expect(result).toBeDefined();
    expect(result.outputFiles).toBeDefined();
    expect(result.outputFiles?.length).toBeGreaterThan(0);

    const outputFile = result.outputFiles?.find(
      (f) => f.name === 'output_from_script.txt',
    );
    expect(outputFile).toBeDefined();

    // Verify file was created in process.cwd()
    const fullPath = path.join(process.cwd(), 'output_from_script.txt');
    const exists = await fs
      .access(fullPath)
      .then(() => true)
      .catch(() => false);
    expect(exists).toBe(true);

    const content = await fs.readFile(fullPath, 'utf-8');
    expect(content).toBe('hello from script file');
  });

  it('handles file collisions by appending a numeric suffix', async () => {
    const executor = new UnsafeLocalCodeExecutor();
    const toolset = new SkillToolset([testSkill], {codeExecutor: executor});
    const tool = new RunSkillScriptTool(toolset);

    // Pre-create the target file to force a collision
    const targetFile = path.join(process.cwd(), 'output_from_script.txt');
    await fs.writeFile(targetFile, 'existing content');

    const result = (await tool.runAsync({
      args: {
        skill_name: 'test-skill',
        script_path: 'scripts/create_file.js',
      },
      toolContext: createMockContext(),
    })) as CodeExecutionResult;

    expect(result).toBeDefined();
    expect(result.outputFiles).toBeDefined();

    const outputFile = result.outputFiles?.find(
      (f) => f.name === 'output_from_script_2.txt',
    );
    expect(outputFile).toBeDefined();

    // Verify collision file was created in process.cwd()
    const fullPath = path.join(process.cwd(), 'output_from_script_2.txt');
    const exists = await fs
      .access(fullPath)
      .then(() => true)
      .catch(() => false);
    expect(exists).toBe(true);

    const content = await fs.readFile(fullPath, 'utf-8');
    expect(content).toBe('hello from script file');
  });
});
