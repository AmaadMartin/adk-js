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
import {buildCodeExecutionResultPart} from '@google/adk/code_executors/code_execution_utils.js';
import {Outcome} from '@google/genai';
import {EventEmitter} from 'node:events';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

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

const IS_WINDOWS = os.platform() === 'win32';

const POWERSHELL_COMMAND = os.platform() === 'win32' ? 'powershell' : 'pwsh';

/**
 * The grace period the executor gives a timed-out execution between `SIGTERM`
 * and `SIGKILL`.
 */
const TERMINATE_GRACE_MS = 5000;

/** A stdio stream of {@link createFakeChild}. */
class FakeStream extends EventEmitter {
  destroy(): void {
    this.emit('close');
  }
}

/**
 * A child process that records the signals it is sent and closes only when
 * told to, so a teardown can be observed step by step.
 */
function createFakeChild(pid: number, signalled: string[]) {
  return Object.assign(new EventEmitter(), {
    pid,
    stdout: new FakeStream(),
    stderr: new FakeStream(),
    kill: (signal: string) => {
      signalled.push(`child:${signal}`);
      return true;
    },
  });
}

/** Python translates `\n` to the host's line ending; compare the text. */
function normalize(text: string): string {
  return text.replace(/\r\n/g, '\n');
}

/** Whether `pid` still names a process this test can signal. */
function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForExit(pid: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline && isAlive(pid)) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

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

  it('times out even when the script leaves a child holding the pipes open', async () => {
    // An interpreter that forks rather than exec's its work leaves a survivor
    // that keeps stdout/stderr open after the kill. 'close' waits on those
    // streams, so before the read ends were released this hung forever and no
    // timeout value bounded it -- the flake behind #622 on Windows.
    const timeoutSeconds = 0.5;
    const survivorLifetimeMs = 60_000;
    const timedOutExecutor = new UnsafeLocalCodeExecutor({timeoutSeconds});
    const params: ExecuteCodeParams = {
      invocationContext,
      codeExecutionInput: {
        code: [
          'const {spawn} = require("node:child_process");',
          `spawn(process.execPath, ['-e', 'setTimeout(() => {}, ${survivorLifetimeMs})'], {`,
          '  stdio: "inherit",',
          '});',
          `setTimeout(() => {}, ${survivorLifetimeMs});`,
        ].join('\n'),
        language: CodeExecutionLanguage.JAVASCRIPT,
        inputFiles: [],
      },
    };

    const startedAt = Date.now();
    const result = await timedOutExecutor.executeCode(params);

    expect(result.stderr).toContain(
      `Code execution timed out after ${timeoutSeconds} seconds.`,
    );
    // Comfortably under the survivor's lifetime: the point is that the wait is
    // bounded by our timer rather than by the survivor exiting on its own.
    expect(Date.now() - startedAt).toBeLessThan(15_000);
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
  });

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
  });

  describe('configuration it cannot honour', () => {
    it('is neither stateful nor data-file optimizing', () => {
      expect(executor.stateful).toBe(false);
      expect(executor.optimizeDataFile).toBe(false);
    });

    it('rejects a stateful executor', () => {
      expect(() => new UnsafeLocalCodeExecutor({stateful: true})).toThrow(
        'Cannot set `stateful=true` in UnsafeLocalCodeExecutor.',
      );
      expect(
        () => new UnsafeLocalCodeExecutor({stateful: false}),
      ).not.toThrow();
    });

    it('rejects data file optimization', () => {
      expect(
        () => new UnsafeLocalCodeExecutor({optimizeDataFile: true}),
      ).toThrow(
        'Cannot set `optimizeDataFile=true` in UnsafeLocalCodeExecutor.',
      );
      expect(
        () => new UnsafeLocalCodeExecutor({optimizeDataFile: false}),
      ).not.toThrow();
    });
  });

  describe('python execution', () => {
    afterEach(() => {
      vi.unstubAllEnvs();
    });

    function runPython(code: string, args?: string[]) {
      return executor.executeCode({
        invocationContext,
        codeExecutionInput: {
          code,
          language: CodeExecutionLanguage.PYTHON,
          inputFiles: [],
          args,
        },
      });
    }

    it('reports a clean run as status 0', async () => {
      const result = await runPython("print('done')");

      expect(result.exitCode).toBe(0);
      expect(result.stderr).toBe('');
    });

    it('reports an uncaught exception as status 1', async () => {
      const result = await runPython("print('partial')\n1 / 0");

      // Output written before the failure is no reason to call the run clean.
      expect(normalize(result.stdout)).toBe('partial\n');
      expect(result.exitCode).toBe(1);
    });

    it('preserves a status the program chose', async () => {
      const result = await runPython('import sys\nsys.exit(3)');

      expect(result.exitCode).toBe(3);
    });

    it('sees an ending no in-process hook can', async () => {
      const result = await runPython('import os\nos._exit(5)');

      expect(result.exitCode).toBe(5);
    });

    it.skipIf(IS_WINDOWS)(
      'reports a negative status when a signal kills the code',
      async () => {
        const result = await runPython(
          'import os, signal\nos.kill(os.getpid(), signal.SIGKILL)',
        );

        expect(result.exitCode).toBe(-9);
      },
    );

    it('runs code guarded on __main__', async () => {
      const result = await runPython(
        "if __name__ == '__main__':\n  print('guarded')",
      );

      expect(normalize(result.stdout)).toBe('guarded\n');
      expect(result.stderr).toBe('');
    });

    it('does not name unguarded code __main__', async () => {
      const result = await runPython("print(globals().get('__name__'))");

      expect(normalize(result.stdout)).toBe('None\n');
    });

    it('separates stdout from stderr, and keeps a warning of a clean run', async () => {
      const result = await runPython(
        [
          'import sys',
          "sys.stdout.write('to out')",
          "sys.stderr.write('to err')",
          'sys.exit(0)',
        ].join('\n'),
      );

      expect(result.stdout).toBe('to out');
      expect(result.stderr).toBe('to err');
      // The status, not the warning, is what says the run failed.
      expect(buildCodeExecutionResultPart(result).codeExecutionResult).toEqual({
        outcome: Outcome.OUTCOME_OK,
      });
    });

    it('reports a silent non-zero exit as a failure', async () => {
      const result = await runPython('import sys\nsys.exit(3)');

      expect(result.stdout).toBe('');
      expect(result.stderr).toBe('Code execution exited with status 3.');
    });

    it('reports a crash rather than hanging', async () => {
      const result = await runPython(
        "import os\nprint('before', flush=True)\nos._exit(3)",
      );

      expect(normalize(result.stdout)).toBe('before\n');
      expect(result.stderr).toBe('Code execution exited with status 3.');
    });

    it.skipIf(IS_WINDOWS)('reports death by signal', async () => {
      const result = await runPython(
        'import os, signal\nos.kill(os.getpid(), signal.SIGKILL)',
      );

      expect(result.stdout).toBe('');
      expect(result.stderr).toBe('Code execution exited with status -9.');
    });

    it('keeps this module out of the traceback', async () => {
      const result = await runPython(
        'def divide():\n  return 1 / 0\n\ndivide()',
      );

      expect(result.stderr).toContain('ZeroDivisionError');
      expect(result.stderr).not.toContain('unsafe_local_code_executor');
      // The wrapper runs the program from its own `-c` source, which python
      // names `<string>`. That frame is the one the runner drops.
      expect(result.stderr).not.toContain('File "<string>"');
      // Both frames of the executed code survive.
      expect(result.stderr.match(/File "<code>"/g)).toHaveLength(2);
    });

    it('preserves unicode', async () => {
      const result = await runPython("print('你好, café')");

      expect(normalize(result.stdout)).toBe('你好, café\n');
      expect(result.stderr).toBe('');
    });

    it('does not let the host locale pick the output encoding', async () => {
      // A host that asks python for ASCII: the child would otherwise die
      // encoding its own output.
      vi.stubEnv('LC_ALL', 'C');
      vi.stubEnv('LANG', 'C');
      vi.stubEnv('PYTHONUTF8', '0');
      vi.stubEnv('PYTHONCOERCECLOCALE', '0');

      const result = await runPython(
        "import sys\nprint(sys.stdout.encoding)\nprint('café')",
      );

      const [encoding, text] = normalize(result.stdout).trimEnd().split('\n');
      expect(encoding.toLowerCase()).toBe('utf-8');
      expect(text).toBe('café');
      expect(result.stderr).toBe('');
    });

    it('reads out output far larger than a pipe buffer', async () => {
      const result = await runPython("print('x' * 1000000)");

      expect(normalize(result.stdout)).toBe(`${'x'.repeat(1000000)}\n`);
      expect(result.stderr).toBe('');
    }, 30_000);

    it('runs a program too large for a single argument', async () => {
      const payload = 'a'.repeat(300000);

      const result = await runPython(`data = '${payload}'\nprint(len(data))`);

      expect(normalize(result.stdout)).toBe(`${payload.length}\n`);
      expect(result.stderr).toBe('');
    }, 30_000);

    it('resolves imports from the agent path', async () => {
      // The directory arrives in argv rather than in the source, so the test
      // does not have to escape a windows path into a python literal.
      const result = await runPython(
        [
          'import os, sys',
          'wanted = os.path.normcase(sys.argv[1])',
          'print(any(os.path.normcase(p) == wanted for p in sys.path))',
        ].join('\n'),
        [process.cwd()],
      );

      expect(normalize(result.stdout)).toBe('True\n');
    });

    it('leaves the caller arguments in argv', async () => {
      const result = await runPython('import sys\nprint(sys.argv[1:])', [
        'one',
        'two',
      ]);

      expect(normalize(result.stdout)).toBe("['one', 'two']\n");
    });

    it('returns a file the program wrote', async () => {
      const result = await runPython(
        "with open('out.txt', 'w') as f:\n  f.write('from python')",
      );

      expect(result.outputFiles.map((file) => file.name)).toEqual(['out.txt']);
      expect(result.outputFiles[0].content).toBe('from python');
    });
  });

  describe('result assembly for other languages', () => {
    function runJavaScript(code: string) {
      return executor.executeCode({
        invocationContext,
        codeExecutionInput: {
          code,
          language: CodeExecutionLanguage.JAVASCRIPT,
          inputFiles: [],
        },
      });
    }

    it('reports a clean run as status 0, and keeps what it wrote', async () => {
      const result = await runJavaScript('console.error("just a warning");');

      expect(result.exitCode).toBe(0);
      // Only python's stderr is cleared on a clean exit: a script in another
      // language can call a script that fails without changing this status.
      expect(result.stderr).toContain('just a warning');
    });

    it('reports a silent non-zero exit as a failure', async () => {
      const result = await runJavaScript('process.exit(4);');

      expect(result.exitCode).toBe(4);
      expect(result.stderr).toBe('Code execution exited with status 4.');
    });
  });

  describe('timeout teardown', () => {
    const timeoutSeconds = 2;
    let signalled: string[];
    let child: ReturnType<typeof createFakeChild>;

    beforeEach(() => {
      signalled = [];
      child = createFakeChild(4321, signalled);
      vi.spyOn(process, 'kill').mockImplementation((pid, signal) => {
        signalled.push(`group:${pid}:${String(signal)}`);
        return true;
      });
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
      vi.restoreAllMocks();
    });

    /** Starts an execution, and reports when its child has been spawned. */
    function startExecution() {
      let spawned!: () => void;
      const hasSpawned = new Promise<void>((resolve) => {
        spawned = resolve;
      });
      spawnMock.mockImplementation(() => {
        spawned();
        return child;
      });

      const result = new UnsafeLocalCodeExecutor({
        timeoutSeconds,
      }).executeCode({
        invocationContext,
        codeExecutionInput: {
          code: 'setTimeout(() => {}, 60000);',
          language: CodeExecutionLanguage.JAVASCRIPT,
          inputFiles: [],
        },
      });
      return {result, hasSpawned};
    }

    /** Windows has no process group to signal, so only the child is reached. */
    function signalsFor(signal: string): string[] {
      return IS_WINDOWS
        ? [`child:${signal}`]
        : [`group:-4321:${signal}`, `child:${signal}`];
    }

    it('signals the group before the child, and kills only after the grace period', async () => {
      const {result, hasSpawned} = startExecution();
      await hasSpawned;

      await vi.advanceTimersByTimeAsync(timeoutSeconds * 1000);
      expect(signalled).toEqual(signalsFor('SIGTERM'));

      await vi.advanceTimersByTimeAsync(TERMINATE_GRACE_MS - 1);
      expect(signalled).toEqual(signalsFor('SIGTERM'));

      await vi.advanceTimersByTimeAsync(1);
      expect(signalled).toEqual([
        ...signalsFor('SIGTERM'),
        ...signalsFor('SIGKILL'),
      ]);

      child.emit('close', null, 'SIGKILL');
      await result;
    });

    it.skipIf(IS_WINDOWS)(
      'kills the child even when the group is already gone',
      async () => {
        vi.spyOn(process, 'kill').mockImplementation(() => {
          const error = new Error('kill ESRCH');
          signalled.push('group:ESRCH');
          throw error;
        });
        const {result, hasSpawned} = startExecution();
        await hasSpawned;

        await vi.advanceTimersByTimeAsync(timeoutSeconds * 1000);

        expect(signalled).toEqual(['group:ESRCH', 'child:SIGTERM']);
        child.emit('close', null, 'SIGTERM');
        await result;
      },
    );

    it('keeps what the code wrote before the timeout', async () => {
      const {result, hasSpawned} = startExecution();
      await hasSpawned;
      child.stderr.emit('data', Buffer.from('partial error'));

      await vi.advanceTimersByTimeAsync(timeoutSeconds * 1000);
      child.emit('close', null, 'SIGTERM');

      expect(await result).toMatchObject({
        stderr: `partial error\nCode execution timed out after ${timeoutSeconds} seconds.`,
      });
    });

    it('gives up on pipes that never close', async () => {
      // A survivor of the group holds the read ends open, so the child reports
      // 'close' only once they are released.
      child.stdout.on('close', () => child.emit('close', null, 'SIGKILL'));
      const {result, hasSpawned} = startExecution();
      await hasSpawned;

      await vi.advanceTimersByTimeAsync(
        timeoutSeconds * 1000 + TERMINATE_GRACE_MS,
      );

      expect(await result).toMatchObject({
        stderr: `Code execution timed out after ${timeoutSeconds} seconds.`,
        exitCode: -9,
      });
    });
  });

  describe('a python child that never reads its program', () => {
    it('reports the failure rather than the broken pipe', async () => {
      const stdin = new EventEmitter();
      const child = Object.assign(createFakeChild(4324, []), {
        stdin: Object.assign(stdin, {
          write: () => stdin.emit('error', new Error('write EPIPE')),
          end: () => undefined,
        }),
      });
      spawnMock.mockImplementation(() => {
        setImmediate(() => child.emit('close', 1, null));
        return child;
      });

      const result = await executor.executeCode({
        invocationContext,
        codeExecutionInput: {
          code: "print('never read')",
          language: CodeExecutionLanguage.PYTHON,
          inputFiles: [],
        },
      });

      expect(result.stderr).toBe('Code execution exited with status 1.');
    });
  });

  describe('what a timed-out execution leaves behind', () => {
    it.skipIf(IS_WINDOWS)(
      'takes down the processes the code spawned',
      async () => {
        const ownedDir = await fs.mkdtemp(
          path.join(os.tmpdir(), 'adk_js_executor_test_'),
        );
        const pidFile = path.join(ownedDir, 'spawned.pid');
        // Forked rather than spawned through a second interpreter, so the
        // descendant exists within milliseconds.
        const code = [
          'import os, time',
          'spawned = os.fork()',
          'if spawned == 0:',
          '  time.sleep(60)',
          '  os._exit(0)',
          `with open(${JSON.stringify(pidFile)}, 'w') as f:`,
          '  f.write(str(spawned))',
          'time.sleep(60)',
        ].join('\n');
        let spawnedPid: number | undefined;

        try {
          const result = await new UnsafeLocalCodeExecutor({
            timeoutSeconds: 2,
          }).executeCode({
            invocationContext,
            codeExecutionInput: {
              code,
              language: CodeExecutionLanguage.PYTHON,
              inputFiles: [],
            },
          });
          expect(result.stderr).toContain(
            'Code execution timed out after 2 seconds.',
          );

          spawnedPid = Number((await fs.readFile(pidFile, 'utf-8')).trim());
          expect(spawnedPid).toBeGreaterThan(0);
          await waitForExit(spawnedPid, 10_000);
          expect(isAlive(spawnedPid)).toBe(false);
        } finally {
          if (spawnedPid !== undefined && isAlive(spawnedPid)) {
            process.kill(spawnedPid, 'SIGKILL');
          }
          await fs.rm(ownedDir, {recursive: true, force: true});
        }
      },
      40_000,
    );
  });
});
