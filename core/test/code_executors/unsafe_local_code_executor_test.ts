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
import {EventEmitter} from 'node:events';
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

const POWERSHELL_COMMAND = IS_WINDOWS ? 'powershell' : 'pwsh';

const PYTHON_COMMAND = IS_WINDOWS ? 'python' : 'python3';

/** A stand-in stdio stream that records whether the executor released it. */
type FakeStream = EventEmitter & {
  setEncoding: () => void;
  destroy: () => void;
  destroyed: boolean;
};

/** A stand-in child that records the signals it is sent. */
type FakeChild = EventEmitter & {
  pid: number;
  kill: (signal: string) => boolean;
  stdin: EventEmitter & {write: (chunk: string) => void; end: () => void};
  stdout: FakeStream;
  stderr: FakeStream;
};

function createFakeStream(): FakeStream {
  const stream: FakeStream = Object.assign(new EventEmitter(), {
    setEncoding: () => {},
    destroy: () => {
      stream.destroyed = true;
    },
    destroyed: false,
  });
  return stream;
}

/**
 * A child that never exits on its own. `stdinFails` makes the write report
 * EPIPE, as a child that died before reading the program does.
 */
function createFakeChild(
  pid: number,
  signalled: string[],
  stdinFails = false,
): FakeChild {
  const stdin = Object.assign(new EventEmitter(), {
    write: (chunk: string) => {
      if (stdinFails) {
        stdin.emit('error', new Error(`EPIPE writing ${chunk.length} bytes`));
      }
    },
    end: () => {},
  });
  return Object.assign(new EventEmitter(), {
    pid,
    kill: (signal: string) => {
      signalled.push(`child.kill(${signal})`);
      return true;
    },
    stdin,
    stdout: createFakeStream(),
    stderr: createFakeStream(),
  });
}

/** Whether `pid` names a process that still exists. */
function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
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

  function pythonParams(code: string): ExecuteCodeParams {
    return {
      invocationContext,
      codeExecutionInput: {
        code,
        language: CodeExecutionLanguage.PYTHON,
        inputFiles: [],
      },
    };
  }

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
        // The exit status is what marks a run failed, so a program whose
        // stderr must survive has to exit non-zero.
        code: 'console.error("An error occurred");\nprocess.exit(1);',
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

    it('runs python through the runner on stdin rather than a script file', async () => {
      await executor.executeCode({
        invocationContext,
        codeExecutionInput: {
          code: "if __name__ == '__main__':\n  print('hi')",
          language: CodeExecutionLanguage.PYTHON,
          inputFiles: [],
        },
      });

      expect(spawnMock).toHaveBeenCalledWith(
        PYTHON_COMMAND,
        ['-c', expect.stringContaining('sys.stdin.buffer.read()'), '__main__'],
        expect.anything(),
      );
    });

    it('gives the python child its own environment and leaves other languages inheriting', async () => {
      await executor.executeCode({
        invocationContext,
        codeExecutionInput: {
          code: 'print("hi")',
          language: CodeExecutionLanguage.PYTHON,
          inputFiles: [],
        },
      });
      await executor.executeCode({
        invocationContext,
        codeExecutionInput: {
          code: 'console.log("hi");',
          language: CodeExecutionLanguage.JAVASCRIPT,
          inputFiles: [],
        },
      });

      expect(spawnMock.mock.calls[0][2]).toEqual(
        expect.objectContaining({
          env: expect.objectContaining({PYTHONIOENCODING: 'utf-8'}),
        }),
      );
      expect(spawnMock.mock.calls[1][2]).toEqual(
        expect.objectContaining({env: undefined}),
      );
    });

    it('leads its own process group everywhere but Windows', async () => {
      await executor.executeCode({
        invocationContext,
        codeExecutionInput: {
          code: 'console.log("hi");',
          language: CodeExecutionLanguage.JAVASCRIPT,
          inputFiles: [],
        },
      });

      expect(spawnMock).toHaveBeenCalledWith(
        expect.anything(),
        expect.anything(),
        expect.objectContaining({detached: !IS_WINDOWS}),
      );
    });
  });

  it('reports itself stateless and unable to optimize data files', () => {
    expect(executor.stateful).toBe(false);
    expect(executor.optimizeDataFile).toBe(false);
  });

  describe('exit status classification', () => {
    it('clears stderr when python writes to it and exits 0', async () => {
      const result = await executor.executeCode(
        pythonParams(
          [
            'import sys',
            "sys.stdout.write('to out')",
            "sys.stderr.write('to err')",
            'sys.exit(0)',
          ].join('\n'),
        ),
      );

      expect(result.stdout).toBe('to out');
      expect(result.stderr).toBe('');
    });

    it('clears stderr when javascript writes to it and exits 0', async () => {
      const result = await executor.executeCode({
        invocationContext,
        codeExecutionInput: {
          code: 'console.error("a deprecation warning");',
          language: CodeExecutionLanguage.JAVASCRIPT,
          inputFiles: [],
        },
      });

      expect(result.stderr).toBe('');
    });

    it('reports a silent non-zero exit', async () => {
      const result = await executor.executeCode(
        pythonParams('import sys\nsys.exit(3)'),
      );

      expect(result.stdout).toBe('');
      expect(result.stderr).toBe('Code execution exited with status 3.');
    });

    it('reports an exit no in-process hook can see, keeping the output', async () => {
      const result = await executor.executeCode(
        pythonParams("import os\nprint('before', flush=True)\nos._exit(5)"),
      );

      expect(result.stdout).toBe(`before${os.EOL === '\r\n' ? '\r\n' : '\n'}`);
      expect(result.stderr).toBe('Code execution exited with status 5.');
    });

    it.skipIf(IS_WINDOWS)(
      'reports death by signal rather than a timeout',
      async () => {
        const result = await executor.executeCode(
          pythonParams(
            'import os, signal\nos.kill(os.getpid(), signal.SIGKILL)',
          ),
        );

        expect(result.stdout).toBe('');
        expect(result.stderr).toBe('Code execution exited with status -9.');
      },
    );

    it('keeps a failed spawn reported rather than clearing it', async () => {
      const customExecutor = new UnsafeLocalCodeExecutor({
        pythonCommandPath: 'non-existent-python-executable-789',
      });

      const result = await customExecutor.executeCode(
        pythonParams('print("test")'),
      );

      // A failed spawn closes with a null code, which must not be read as the
      // clean exit that clears stderr.
      expect(result.stderr).not.toBe('');
      expect(result.stderr).toContain('Process error:');
    });

    it('writes the timeout note alone when the program said nothing', async () => {
      const timeoutSeconds = 0.5;
      const result = await new UnsafeLocalCodeExecutor({
        timeoutSeconds,
      }).executeCode({
        invocationContext,
        codeExecutionInput: {
          code: 'setTimeout(() => {}, 60000);',
          language: CodeExecutionLanguage.JAVASCRIPT,
          inputFiles: [],
        },
      });

      expect(result.stderr).toBe(
        `Code execution timed out after ${timeoutSeconds} seconds.`,
      );
    });

    it('separates the timeout note from output the program wrote', async () => {
      const timeoutSeconds = 0.5;
      const result = await new UnsafeLocalCodeExecutor({
        timeoutSeconds,
      }).executeCode({
        invocationContext,
        codeExecutionInput: {
          code: 'console.error("before the hang");\nsetTimeout(() => {}, 60000);',
          language: CodeExecutionLanguage.JAVASCRIPT,
          inputFiles: [],
        },
      });

      expect(result.stderr).toBe(
        `before the hang\n\nCode execution timed out after ${timeoutSeconds} seconds.`,
      );
    });
  });

  describe('python runner semantics', () => {
    it('runs code guarded on __main__', async () => {
      const result = await executor.executeCode(
        pythonParams("if __name__ == '__main__':\n  print('guarded')"),
      );

      expect(result.stdout.trim()).toBe('guarded');
      expect(result.stderr).toBe('');
    });

    it('does not name unguarded code __main__', async () => {
      const result = await executor.executeCode(
        pythonParams("print(globals().get('__name__'))"),
      );

      expect(result.stdout.trim()).toBe('None');
    });

    it('shows the model its own traceback frames and none of ours', async () => {
      const result = await executor.executeCode(
        pythonParams('def divide():\n  return 1 / 0\n\ndivide()'),
      );

      expect(result.stderr).toContain('ZeroDivisionError');
      expect(result.stderr).not.toContain('unsafe_local_code_executor');
      expect(result.stderr.split('File "<code>"').length - 1).toBe(2);
    });

    it('runs a program too large for a single argument', async () => {
      const payload = 'a'.repeat(300000);

      const result = await executor.executeCode(
        pythonParams(`data = '${payload}'\nprint(len(data))`),
      );

      expect(result.stdout.trim()).toBe('300000');
      expect(result.stderr).toBe('');
    });

    it('leaves python stdin at end-of-file', async () => {
      const result = await executor.executeCode(
        pythonParams("try:\n  input()\nexcept EOFError:\n  print('eof')\n"),
      );

      expect(result.stdout.trim()).toBe('eof');
      expect(result.stderr).toBe('');
    });

    it('leaves stdin at end-of-file for other languages too', async () => {
      const result = await executor.executeCode({
        invocationContext,
        codeExecutionInput: {
          code: [
            'let read = 0;',
            'process.stdin.on("data", (c) => { read += c.length; });',
            'process.stdin.on("end", () => console.log("eof:" + read));',
          ].join('\n'),
          language: CodeExecutionLanguage.JAVASCRIPT,
          inputFiles: [],
        },
      });

      expect(result.stdout.trim()).toBe('eof:0');
    });

    it('survives a python child that dies before reading the program', async () => {
      // Without a listener on the write end, the EPIPE this child reports is
      // an unhandled stream error and takes the agent down with it.
      spawnMock.mockImplementation(() => {
        const child = createFakeChild(1234, [], true);
        setImmediate(() => child.emit('close', 1, null));
        return child;
      });

      const result = await executor.executeCode(pythonParams('print("hi")'));

      expect(result.stderr).toBe('Code execution exited with status 1.');
    });

    it("keeps the caller's arguments in a python program's argv", async () => {
      const result = await executor.executeCode({
        invocationContext,
        codeExecutionInput: {
          code: 'import sys\nprint(sys.argv[1:])',
          language: CodeExecutionLanguage.PYTHON,
          inputFiles: [],
          args: ['alpha', 'beta'],
        },
      });

      expect(result.stdout.trim()).toBe("['alpha', 'beta']");
      expect(result.stderr).toBe('');
    });
  });

  describe('python child environment', () => {
    it('pins the output encoding rather than following the host locale', async () => {
      const result = await executor.executeCode(
        pythonParams('import sys\nprint(sys.stdout.encoding)'),
      );

      expect(result.stdout.trim().toLowerCase()).toBe('utf-8');
    });

    it('round-trips non-ASCII output', async () => {
      const result = await executor.executeCode(
        pythonParams("print('你好, café')"),
      );

      expect(result.stdout.trim()).toBe('你好, café');
      expect(result.stderr).toBe('');
    });

    it('reads out output far larger than a pipe buffer', async () => {
      const result = await executor.executeCode(
        pythonParams("print('x' * 1000000)"),
      );

      expect(result.stdout.trim()).toBe('x'.repeat(1000000));
      expect(result.stderr).toBe('');
    }, 30000);

    it('keeps a multi-byte character split across a chunk boundary intact', async () => {
      const count = 400000;

      const result = await executor.executeCode(
        pythonParams(`print('你' * ${count})`),
      );

      expect(result.stdout).not.toContain('\uFFFD');
      expect(result.stdout.trim()).toBe('你'.repeat(count));
    }, 30000);

    it("puts the agent's import path on the child's sys.path", async () => {
      const result = await executor.executeCode(
        pythonParams(
          `import sys\nprint(${JSON.stringify(process.cwd())} in sys.path)`,
        ),
      );

      expect(result.stdout.trim()).toBe('True');
      expect(result.stderr).toBe('');
    });
  });

  describe('process group teardown', () => {
    // Mirrors TERMINATE_GRACE_MS in the executor.
    const TERMINATE_GRACE_MS = 5000;
    const FAKE_PID = 4242;

    afterEach(() => {
      vi.useRealTimers();
    });

    /**
     * Drives one timed-out execution against a child that never closes on its
     * own, recording every signal in the order it was sent.
     */
    async function runFakeTimeout(
      timeoutSeconds: number,
      groupSignalFails = false,
    ) {
      vi.useFakeTimers({toFake: ['setTimeout', 'clearTimeout']});
      const signalled: string[] = [];
      const killSpy = vi
        .spyOn(process, 'kill')
        .mockImplementation((pid: number, signal?: string | number) => {
          signalled.push(`process.kill(${pid}, ${String(signal)})`);
          if (groupSignalFails) {
            throw Object.assign(new Error('no such process'), {code: 'ESRCH'});
          }
          return true;
        });

      let announceSpawn: (child: FakeChild) => void = () => {};
      const spawned = new Promise<FakeChild>((resolve) => {
        announceSpawn = resolve;
      });
      spawnMock.mockImplementation(() => {
        const child = createFakeChild(FAKE_PID, signalled);
        announceSpawn(child);
        return child;
      });

      const run = new UnsafeLocalCodeExecutor({timeoutSeconds}).executeCode({
        invocationContext,
        codeExecutionInput: {
          code: 'console.log("never finishes");',
          language: CodeExecutionLanguage.JAVASCRIPT,
          inputFiles: [],
        },
      });

      return {child: await spawned, killSpy, run, signalled};
    }

    it('signals the group before killing it, after the grace period', async () => {
      const {child, killSpy, run, signalled} = await runFakeTimeout(1);

      vi.advanceTimersByTime(1000);
      expect(signalled).toEqual([
        ...(IS_WINDOWS ? [] : [`process.kill(${-FAKE_PID}, SIGTERM)`]),
        'child.kill(SIGTERM)',
      ]);

      vi.advanceTimersByTime(TERMINATE_GRACE_MS - 1);
      expect(signalled).toHaveLength(IS_WINDOWS ? 1 : 2);

      vi.advanceTimersByTime(1);
      expect(signalled).toEqual([
        ...(IS_WINDOWS ? [] : [`process.kill(${-FAKE_PID}, SIGTERM)`]),
        'child.kill(SIGTERM)',
        ...(IS_WINDOWS ? [] : [`process.kill(${-FAKE_PID}, SIGKILL)`]),
        'child.kill(SIGKILL)',
      ]);
      // A survivor holding the read ends would otherwise hold 'close' back.
      expect(child.stdout.destroyed).toBe(true);
      expect(child.stderr.destroyed).toBe(true);

      killSpy.mockRestore();
      child.emit('close', null, 'SIGKILL');
      await run;
    });

    it('disarms the escalation when the child closes within the grace period', async () => {
      const {child, killSpy, run, signalled} = await runFakeTimeout(1);

      vi.advanceTimersByTime(1000);
      child.emit('close', null, 'SIGTERM');
      await run;
      const afterClose = [...signalled];

      vi.advanceTimersByTime(TERMINATE_GRACE_MS * 2);

      // A recycled pid would otherwise take an unrelated group with it.
      expect(signalled).toEqual(afterClose);
      expect(signalled.join(' ')).not.toContain('SIGKILL');
      killSpy.mockRestore();
    });

    it.skipIf(IS_WINDOWS)(
      'still kills the child when the group is already empty',
      async () => {
        const {child, killSpy, run, signalled} = await runFakeTimeout(1, true);

        vi.advanceTimersByTime(1000);

        expect(signalled).toEqual([
          `process.kill(${-FAKE_PID}, SIGTERM)`,
          'child.kill(SIGTERM)',
        ]);

        killSpy.mockRestore();
        child.emit('close', null, 'SIGTERM');
        await run;
      },
    );

    it.skipIf(IS_WINDOWS)(
      'takes down what the timed-out code spawned',
      async () => {
        const timeoutSeconds = 2;
        const result = await new UnsafeLocalCodeExecutor({
          timeoutSeconds,
        }).executeCode({
          invocationContext,
          codeExecutionInput: {
            code: [
              'const {spawn} = require("node:child_process");',
              'const fs = require("node:fs");',
              'const grandchild = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], {stdio: "ignore"});',
              // A `.txt` name so the harvested content is text, not base64.
              'fs.writeFileSync("grandchild_pid.txt", String(grandchild.pid));',
              'setTimeout(() => {}, 60000);',
            ].join('\n'),
            language: CodeExecutionLanguage.JAVASCRIPT,
            inputFiles: [],
          },
        });

        expect(result.stderr).toContain(
          `Code execution timed out after ${timeoutSeconds} seconds.`,
        );

        const recorded = result.outputFiles?.find(
          (file) => file.name === 'grandchild_pid.txt',
        );
        if (!recorded) {
          expect.fail('the executed code never recorded a grandchild pid');
        }
        const grandchildPid = Number(recorded.content);
        // Without this the assertion below passes on a pid that never parsed.
        expect(Number.isInteger(grandchildPid)).toBe(true);

        const deadline = Date.now() + 10_000;
        while (Date.now() < deadline && isAlive(grandchildPid)) {
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
        expect(isAlive(grandchildPid)).toBe(false);
      },
      30000,
    );
  });
});
