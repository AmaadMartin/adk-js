/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  CodeExecutionLanguage,
  ExecuteCodeParams,
  FileContentEncoding,
  InvocationContext,
  LlmAgent,
  PluginManager,
  UnsafeLocalCodeExecutor,
  createSession,
} from '@google/adk';
import type {SpawnOptions} from 'node:child_process';
import {EventEmitter} from 'node:events';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

/**
 * Most of these tests spawn a real interpreter. On Windows the shell case means
 * Windows PowerShell, whose cold start on a loaded CI runner costs seconds --
 * enough that `should execute shell code and return stdout` intermittently blew
 * Vitest's 5s default and, through fail-fast, took the macOS and Linux jobs down
 * with it. A healthy Windows run needs ~5.3s for the file as a whole, so the
 * default left no margin.
 *
 * Budget by what is actually under test: the executor's own default timeout is
 * 30s, and a harness that gives up sooner can never observe the behaviour it
 * covers. This is a ceiling, not a delay -- a passing test still finishes in
 * milliseconds.
 */
vi.setConfig({testTimeout: 30_000});

// Only `spawn` is mocked; it defaults to the real implementation (see
// `beforeEach`) so the pre-existing tests still execute real scripts.
const spawnMock = vi.hoisted(() => vi.fn());
vi.mock('node:child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:child_process')>()),
  spawn: spawnMock,
}));

const {spawn: realSpawn} =
  await vi.importActual<typeof import('node:child_process')>(
    'node:child_process',
  );

const POWERSHELL_COMMAND = os.platform() === 'win32' ? 'powershell' : 'pwsh';

// Captured before any environment stubbing so the ESM host package is still
// created under the host's real temporary root.
const REAL_TMPDIR = os.tmpdir();

const POWERSHELL_FLAGS = [
  '-NoLogo',
  '-NoProfile',
  '-ExecutionPolicy',
  'Bypass',
  '-File',
];

const EXPECTED_POWERSHELL_ARGS = [
  ...POWERSHELL_FLAGS,
  expect.stringMatching(/script\.ps1$/),
];

function createMockInvocationContext(): InvocationContext {
  const agent = new LlmAgent({
    name: 'test_agent',
    model: 'gemini-2.5-flash',
  });

  return new InvocationContext({
    invocationId: 'test-invocation',
    agent,
    session: createSession({
      id: 'test-session',
      events: [],
      appName: 'test-app',
      userId: 'test-user',
    }),
    pluginManager: new PluginManager([]),
  });
}

// This suite starts a real interpreter. Process creation on a cold CI runner
// can exhaust Vitest's 5000ms default. 60000ms also clears the executor's own
// 30s SIGKILL deadline, so a hung child reports `Code execution timed out after
// 30 seconds.` instead. Cases that never spawn override the budget back down.
describe('UnsafeLocalCodeExecutor', () => {
  let executor: UnsafeLocalCodeExecutor;
  const invocationContext = createMockInvocationContext();

  beforeEach(() => {
    spawnMock.mockReset();
    spawnMock.mockImplementation(realSpawn);
    executor = new UnsafeLocalCodeExecutor();
  });

  it('should execute code and return stdout', async () => {
    const params: ExecuteCodeParams = {
      invocationContext,
      codeExecutionInput: {
        code: 'console.log("Hello, World!");',
        language: CodeExecutionLanguage.JAVASCRIPT,
        inputFiles: [],
      },
    };

    const result = await executor.executeCode(params);

    expect(result.stdout).toContain('Hello, World!');
    expect(result.stderr).toBe('');
  });

  // The script runs with the temporary directory as its cwd, so it can report
  // the name and mode the executor actually created.
  it('creates a private, unpredictable temporary directory', async () => {
    const params: ExecuteCodeParams = {
      invocationContext,
      codeExecutionInput: {
        code: [
          'const fs = require("node:fs");',
          'const dir = process.cwd();',
          'const mode = (fs.statSync(dir).mode & 0o777).toString(8);',
          'console.log(JSON.stringify({dir, mode}));',
        ].join('\n'),
        language: CodeExecutionLanguage.JAVASCRIPT,
        inputFiles: [],
      },
    };

    const firstResult = await executor.executeCode(params);
    const secondResult = await executor.executeCode(params);
    expect(firstResult.stderr).toBe('');
    expect(secondResult.stderr).toBe('');

    const first = JSON.parse(firstResult.stdout);
    const second = JSON.parse(secondResult.stdout);

    // mkdtemp appends six random characters to the prefix it is given.
    expect(path.basename(first.dir)).toMatch(
      /^adk_js_unsafe_code_executor_.{6}$/,
    );
    expect(second.dir).not.toBe(first.dir);

    if (os.platform() !== 'win32') {
      expect(first.mode).toBe('700');
    }
  });

  // The 60s budget covers a cold `node` start on the windows-latest CI runner
  // and exceeds the executor's own 30s kill deadline, so a hung child reports
  // the executor's timeout message rather than an opaque runner timeout.
  it('removes the scratch directory after a successful execution', async () => {
    let scratchDir: string | undefined;
    // The directory is read off the `spawn` call, not off the script's own
    // `process.cwd()`: `process.cwd()` resolves symlinks, so on macOS the
    // script reports `/private/var/...` while `os.tmpdir()` returns `/var/...`.
    spawnMock.mockImplementation(
      (command: string, args: readonly string[], options: SpawnOptions) => {
        if (typeof options.cwd === 'string') {
          scratchDir = options.cwd;
        }
        return realSpawn(command, args, options);
      },
    );

    const params: ExecuteCodeParams = {
      invocationContext,
      codeExecutionInput: {
        code: 'console.log("done");',
        language: CodeExecutionLanguage.JAVASCRIPT,
        inputFiles: [],
      },
    };

    const result = await executor.executeCode(params);

    // Proves the child really ran, so the removal asserted below is the
    // post-execution cleanup and not a cleanup after a script that never
    // started.
    expect(result.stdout).toContain('done');
    expect(result.stderr).toBe('');
    if (scratchDir === undefined) {
      expect.fail('the executor spawned the script without a string cwd');
    }
    expect(path.dirname(scratchDir)).toBe(os.tmpdir());
    // ENOENT specifically: a bare rejection is also satisfied by EACCES against
    // a directory that is still there.
    await expect(fs.access(scratchDir)).rejects.toMatchObject({code: 'ENOENT'});
  }, 60000);

  it('removes the scratch directory when the child process cannot be spawned', async () => {
    let scratchDir: string | undefined;
    // Same reason as above, and here the failed `spawn` call is the only place
    // the scratch directory's path is observable at all, because no script
    // ever runs.
    spawnMock.mockImplementation(
      (_command: string, _args: readonly string[], options: SpawnOptions) => {
        if (typeof options.cwd === 'string') {
          scratchDir = options.cwd;
        }
        throw new Error('spawn EACCES');
      },
    );

    const params: ExecuteCodeParams = {
      invocationContext,
      codeExecutionInput: {
        code: 'console.log("never runs");',
        language: CodeExecutionLanguage.JAVASCRIPT,
        inputFiles: [],
      },
    };

    await expect(executor.executeCode(params)).rejects.toThrow('spawn EACCES');

    if (scratchDir === undefined) {
      expect.fail('the executor spawned the script without a string cwd');
    }
    expect(path.dirname(scratchDir)).toBe(os.tmpdir());
    await expect(fs.access(scratchDir)).rejects.toMatchObject({code: 'ENOENT'});
  });

  it('should capture stderr', async () => {
    const params: ExecuteCodeParams = {
      invocationContext,
      codeExecutionInput: {
        code: 'console.error("An error occurred");',
        language: CodeExecutionLanguage.JAVASCRIPT,
        inputFiles: [],
      },
    };

    const result = await executor.executeCode(params);

    expect(result.stderr).toContain('An error occurred');
  });

  it('should handle execution errors', async () => {
    const params: ExecuteCodeParams = {
      invocationContext,
      codeExecutionInput: {
        code: 'throw new Error("Fatal error");',
        language: CodeExecutionLanguage.JAVASCRIPT,
        inputFiles: [],
      },
    };

    const result = await executor.executeCode(params);

    expect(result.stderr).toContain('Fatal error');
  });

  it('should respect timeout', async () => {
    // Create executor with 1 second timeout
    const shortTimeoutExecutor = new UnsafeLocalCodeExecutor({
      timeoutSeconds: 1,
    });

    const params: ExecuteCodeParams = {
      invocationContext,
      codeExecutionInput: {
        code: 'setTimeout(() => {}, 5000);', // Sleep for 5 seconds
        language: CodeExecutionLanguage.JAVASCRIPT,
        inputFiles: [],
      },
    };

    const result = await shortTimeoutExecutor.executeCode(params);

    expect(result.stderr).toContain(
      'Code execution timed out after 1 seconds.',
    );
  });

  it('should execute python code and return stdout', async () => {
    const params: ExecuteCodeParams = {
      invocationContext,
      codeExecutionInput: {
        code: 'print("Hello, Python!")',
        language: CodeExecutionLanguage.PYTHON,
        inputFiles: [],
      },
    };

    const result = await executor.executeCode(params);

    expect(result.stdout).toContain('Hello, Python!');
    expect(result.stderr).toBe('');
  });

  it('should execute shell code and return stdout', async () => {
    const params: ExecuteCodeParams = {
      invocationContext,
      codeExecutionInput: {
        code: 'echo "Hello, Shell!"',
        language: CodeExecutionLanguage.SHELL,
        inputFiles: [],
      },
    };

    const result = await executor.executeCode(params);

    expect(result.stdout).toContain('Hello, Shell!');
    expect(result.stderr).toBe('');
  });

  // No process is created: executeCode returns at the language guard.
  it('should return error for unsupported language', async () => {
    const params: ExecuteCodeParams = {
      invocationContext,
      codeExecutionInput: {
        code: 'whatever',
        language: CodeExecutionLanguage.UNSPECIFIED,
        inputFiles: [],
      },
    };

    const result = await executor.executeCode(params);

    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('Unsupported language: unspecified');
  }, 5000);

  it('should respect pythonCommandPath', async () => {
    const customExecutor = new UnsafeLocalCodeExecutor({
      pythonCommandPath: 'non-existent-python-executable-123',
    });

    const params: ExecuteCodeParams = {
      invocationContext,
      codeExecutionInput: {
        code: 'print("test")',
        language: CodeExecutionLanguage.PYTHON,
        inputFiles: [],
      },
    };

    const result = await customExecutor.executeCode(params);

    expect(result.stderr).toContain('Process error:');
    expect(result.stderr).toContain('non-existent-python-executable-123');
  });

  it('should respect shellCommandPath', async () => {
    const customExecutor = new UnsafeLocalCodeExecutor({
      shellCommandPath: 'non-existent-shell-executable-456',
    });

    const params: ExecuteCodeParams = {
      invocationContext,
      codeExecutionInput: {
        code: 'echo "test"',
        language: CodeExecutionLanguage.SHELL,
        inputFiles: [],
      },
    };

    const result = await customExecutor.executeCode(params);

    expect(result.stderr).toContain('Process error:');
    expect(result.stderr).toContain('non-existent-shell-executable-456');
  });

  it('should pass array arguments to the script', async () => {
    const params: ExecuteCodeParams = {
      invocationContext,
      codeExecutionInput: {
        code: 'console.log(process.argv.slice(2).join(" "));',
        language: CodeExecutionLanguage.JAVASCRIPT,
        inputFiles: [],
        args: ['arg1', 'arg2', 'arg3'],
      },
    };

    const result = await executor.executeCode(params);

    expect(result.stdout).toContain('arg1 arg2 arg3');
    expect(result.stderr).toBe('');
  });

  it('should pass object arguments as --key value to the script', async () => {
    const params: ExecuteCodeParams = {
      invocationContext,
      codeExecutionInput: {
        code: 'console.log(process.argv.slice(2).join(" "));',
        language: CodeExecutionLanguage.JAVASCRIPT,
        inputFiles: [],
        args: {foo: 'bar', flag: true, count: 42},
      },
    };

    const result = await executor.executeCode(params);

    expect(result.stdout).toContain('--foo bar --flag true --count 42');
    expect(result.stderr).toBe('');
  });

  it('should materialize input files in the temporary directory', async () => {
    const params: ExecuteCodeParams = {
      invocationContext,
      codeExecutionInput: {
        code: 'const fs = require("fs"); console.log(fs.readFileSync("test.txt", "utf8")); console.log(fs.readFileSync("subdir/data.json", "utf8"));',
        language: CodeExecutionLanguage.JAVASCRIPT,
        inputFiles: [
          {
            name: 'test.txt',
            content: Buffer.from('hello file content').toString('base64'),
            contentEncoding: FileContentEncoding.BASE64,
            mimeType: 'text/plain',
          },
          {
            name: 'subdir/data.json',
            content: '{"key": "value"}',
            contentEncoding: FileContentEncoding.UTF8,
            mimeType: 'application/json',
          },
        ],
      },
    };

    const result = await executor.executeCode(params);

    expect(result.stdout).toContain('hello file content');
    expect(result.stdout).toContain('{"key": "value"}');
    expect(result.stderr).toBe('');
  });

  it('should return only new files, excluding input files', async () => {
    const params: ExecuteCodeParams = {
      invocationContext,
      codeExecutionInput: {
        code: 'const fs = require("fs"); fs.writeFileSync("new_output.txt", "hello from script");',
        language: CodeExecutionLanguage.JAVASCRIPT,
        inputFiles: [
          {
            name: 'existing_input.txt',
            content: Buffer.from('hello input').toString('base64'),
            contentEncoding: FileContentEncoding.BASE64,
            mimeType: 'text/plain',
          },
        ],
      },
    };

    const result = await executor.executeCode(params);

    expect(result.outputFiles).toBeDefined();
    expect(result.outputFiles!.length).toBe(1);
    expect(result.outputFiles![0].name).toBe('new_output.txt');
    expect(result.outputFiles![0].content).toBe('hello from script');
    expect(result.outputFiles![0].contentEncoding).toBe('utf-8');
    expect(result.outputFiles![0].mimeType).toBe('text/plain');
  });

  it('should infer correct mimeType for generated JSON files', async () => {
    const params: ExecuteCodeParams = {
      invocationContext,
      codeExecutionInput: {
        code: 'const fs = require("fs"); fs.writeFileSync("output.json", JSON.stringify({hello: "world"}));',
        language: CodeExecutionLanguage.JAVASCRIPT,
        inputFiles: [],
      },
    };

    const result = await executor.executeCode(params);

    expect(result.outputFiles).toBeDefined();
    expect(result.outputFiles!.length).toBe(1);
    expect(result.outputFiles![0].name).toBe('output.json');
    expect(result.outputFiles![0].content).toBe('{"hello":"world"}');
    expect(result.outputFiles![0].contentEncoding).toBe('utf-8');
    expect(result.outputFiles![0].mimeType).toBe('application/json');
  });

  it('does not report the generated module-scope manifest as an output file', async () => {
    const params: ExecuteCodeParams = {
      invocationContext,
      codeExecutionInput: {
        code: 'const fs = require("node:fs"); fs.writeFileSync("out.txt", "written");',
        language: CodeExecutionLanguage.JAVASCRIPT,
        inputFiles: [],
      },
    };

    const result = await executor.executeCode(params);

    expect(result.stderr).toBe('');
    expect(result.outputFiles?.map((f) => f.name)).toEqual(['out.txt']);
  });

  // Node resolves a `.js` file's module system from the nearest enclosing
  // `package.json`, so a temporary root inside an ESM package used to make
  // every `require()` program fail.
  describe('scratch directory module scope', () => {
    let esmPackageDir: string;

    beforeEach(async () => {
      esmPackageDir = await fs.mkdtemp(
        path.join(REAL_TMPDIR, 'adk_js_esm_host_'),
      );
      await fs.writeFile(
        path.join(esmPackageDir, 'package.json'),
        JSON.stringify({name: 'esm-host', type: 'module'}),
      );
      vi.stubEnv('TMPDIR', esmPackageDir);
      vi.stubEnv('TMP', esmPackageDir);
      vi.stubEnv('TEMP', esmPackageDir);
    });

    afterEach(async () => {
      vi.unstubAllEnvs();
      await fs.rm(esmPackageDir, {recursive: true, force: true});
    });

    it('runs a require()-based program when the temporary directory is nested inside an ES module package', async () => {
      const result = await executor.executeCode({
        invocationContext,
        codeExecutionInput: {
          code: 'const os = require("node:os"); console.log("cjs ran on", typeof os.platform());',
          language: CodeExecutionLanguage.JAVASCRIPT,
          inputFiles: [],
        },
      });

      expect(result.stderr).toBe('');
      expect(result.stdout).toContain('cjs ran on');
    });

    // Node warns about the manifest having no `"type"` field, so stderr is not
    // empty here. Pinning `"commonjs"` instead would break this program.
    it('runs an import-based program when the temporary directory is nested inside an ES module package', async () => {
      const result = await executor.executeCode({
        invocationContext,
        codeExecutionInput: {
          code: 'import os from "node:os"; console.log("esm ran on", typeof os.platform());',
          language: CodeExecutionLanguage.JAVASCRIPT,
          inputFiles: [],
        },
      });

      expect(result.stdout).toContain('esm ran on');
      expect(result.stderr).not.toContain('Cannot use import statement');
    });

    // The manifest deliberately beats an input file of the same name: an input
    // `{"type": "module"}` would otherwise re-break module resolution.
    it('gives the module-scope manifest precedence over an input file named package.json', async () => {
      const result = await executor.executeCode({
        invocationContext,
        codeExecutionInput: {
          code: [
            'const fs = require("node:fs");',
            'console.log(JSON.stringify({',
            '  manifest: fs.readFileSync("package.json", "utf8"),',
            '  input: fs.readFileSync("package_2.json", "utf8"),',
            '}));',
          ].join('\n'),
          language: CodeExecutionLanguage.JAVASCRIPT,
          inputFiles: [
            {
              name: 'package.json',
              content: '{"type":"module"}',
              contentEncoding: FileContentEncoding.UTF8,
              mimeType: 'application/json',
            },
          ],
        },
      });

      expect(result.stderr).toBe('');
      expect(JSON.parse(result.stdout)).toEqual({
        manifest: '{}\n',
        input: '{"type":"module"}',
      });
    });
  });

  // This block stubs spawn, so no process is created.
  describe('spawn arguments', () => {
    beforeEach(() => {
      // Return a child process that immediately exits with code 0, so the
      // interpreters under test need not be installed on the host.
      spawnMock.mockImplementation(() => {
        const child = new EventEmitter();
        setImmediate(() => child.emit('close', 0, null));
        return child;
      });
    });

    it('should pass -NoProfile when shell code runs through powershell', async () => {
      const shellExecutor = new UnsafeLocalCodeExecutor({
        shellCommandPath: 'powershell',
      });

      await shellExecutor.executeCode({
        invocationContext,
        codeExecutionInput: {
          code: 'Write-Output "hi"',
          language: CodeExecutionLanguage.SHELL,
          inputFiles: [],
        },
      });

      expect(spawnMock).toHaveBeenCalledWith(
        'powershell',
        // The extension follows the host platform, the command follows
        // `shellCommandPath`.
        [...POWERSHELL_FLAGS, expect.stringMatching(/script\.(ps1|sh)$/)],
        expect.anything(),
      );
    });

    it('should pass -NoProfile for the powershell language, appending user args after the script path without accumulating them across executions', async () => {
      await executor.executeCode({
        invocationContext,
        codeExecutionInput: {
          code: 'Write-Output $args',
          language: CodeExecutionLanguage.POWERSHELL,
          inputFiles: [],
          args: ['first-run-only'],
        },
      });
      await executor.executeCode({
        invocationContext,
        codeExecutionInput: {
          code: 'Write-Output "hi"',
          language: CodeExecutionLanguage.POWERSHELL,
          inputFiles: [],
        },
      });

      expect(spawnMock).toHaveBeenNthCalledWith(
        1,
        POWERSHELL_COMMAND,
        [...EXPECTED_POWERSHELL_ARGS, 'first-run-only'],
        expect.anything(),
      );
      expect(spawnMock).toHaveBeenNthCalledWith(
        2,
        POWERSHELL_COMMAND,
        EXPECTED_POWERSHELL_ARGS,
        expect.anything(),
      );
    });

    it('should pass /D when shell code runs through cmd', async () => {
      const shellExecutor = new UnsafeLocalCodeExecutor({
        shellCommandPath: 'cmd.exe',
      });

      await shellExecutor.executeCode({
        invocationContext,
        codeExecutionInput: {
          code: 'echo hi',
          language: CodeExecutionLanguage.SHELL,
          inputFiles: [],
        },
      });

      expect(spawnMock).toHaveBeenCalledWith(
        'cmd.exe',
        ['/D', '/c', expect.stringMatching(/script\.(bat|sh)$/)],
        expect.anything(),
      );
    });

    it('should pass /D for the windows_cmd language', async () => {
      await executor.executeCode({
        invocationContext,
        codeExecutionInput: {
          code: 'echo hi',
          language: CodeExecutionLanguage.WINDOWS_CMD,
          inputFiles: [],
        },
      });

      expect(spawnMock).toHaveBeenCalledWith(
        'cmd.exe',
        ['/D', '/c', expect.stringMatching(/script\.bat$/)],
        expect.anything(),
      );
    });

    describe('shell command detection', () => {
      async function runShellCode(shellCommandPath: string) {
        await new UnsafeLocalCodeExecutor({shellCommandPath}).executeCode({
          invocationContext,
          codeExecutionInput: {
            code: 'echo "test"',
            language: CodeExecutionLanguage.SHELL,
            inputFiles: [],
          },
        });
      }

      it.each([
        'pwsh',
        'pwsh.exe',
        '/usr/bin/pwsh',
        'C:\\Program Files\\PowerShell\\7\\pwsh.exe',
        'PWSH',
        'powershell',
        'powershell.exe',
      ])('runs a .ps1 script through PowerShell for %s', async (shell) => {
        await runShellCode(shell);

        expect(spawnMock).toHaveBeenCalledWith(
          shell,
          EXPECTED_POWERSHELL_ARGS,
          expect.anything(),
        );
      });

      it.each([
        '/opt/pwsh-tools/bin/bash',
        '/usr/local/powershell-helpers/run.sh',
      ])('does not treat %s as PowerShell', async (shell) => {
        await runShellCode(shell);

        expect(spawnMock).toHaveBeenCalledWith(
          shell,
          [expect.stringMatching(/script\.(sh|ps1)$/)],
          expect.anything(),
        );
      });
    });
  }, 5000);
}, 60000);
