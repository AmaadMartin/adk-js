/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  CodeExecutionLanguage,
  CodeExecutionResult,
  ExecuteCodeParams,
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

const POWERSHELL_COMMAND = os.platform() === 'win32' ? 'powershell' : 'pwsh';

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

const IS_WINDOWS = os.platform() === 'win32';

/** Mirrors `TERMINATE_GRACE_MS` in unsafe_local_code_executor.ts. */
const TERMINATE_GRACE_MS = 5000;

/** Budget for the cases that spawn and then kill real processes. */
const REAL_PROCESS_TIMEOUT_MS = 20000;

const BACKGROUND_PID_FILE = 'background_pid.txt';
const GRANDCHILD_PID_FILE = 'grandchild_pid.txt';

/** Code that leaves one background process behind and reports its pid. */
function backgroundChildScript(
  stdio: 'ignore' | 'inherit',
  trailer = '',
): string {
  return [
    `const {spawn} = require('node:child_process');`,
    `const fs = require('node:fs');`,
    `const background = spawn(process.execPath,`,
    `    ['-e', 'setTimeout(() => {}, 60000)'], {stdio: '${stdio}'});`,
    `background.unref();`,
    `fs.writeFileSync('${BACKGROUND_PID_FILE}', String(background.pid));`,
    trailer,
  ].join('\n');
}

/**
 * Code that leaves a process two levels down. The script holds no handle to
 * the grandchild, so only a group teardown can reach it. The intermediate
 * child is not unreferenced, which keeps the script alive until the pid file
 * exists.
 */
const GRANDCHILD_SCRIPT = [
  `const {spawn} = require('node:child_process');`,
  `const childCode = [`,
  `  "const {spawn} = require('node:child_process');",`,
  `  "const fs = require('node:fs');",`,
  `  "const grandchild = spawn(process.execPath,",`,
  `  "    ['-e', 'setTimeout(() => {}, 60000)'], {stdio: 'ignore'});",`,
  `  "grandchild.unref();",`,
  `  "fs.writeFileSync('${GRANDCHILD_PID_FILE}', String(grandchild.pid));",`,
  `].join('\\n');`,
  `spawn(process.execPath, ['-e', childCode], {stdio: 'ignore'});`,
].join('\n');

/**
 * A stand-in for a spawned child. The executor uses only `pid`, `kill`, the
 * two stdio streams and the `error` / `exit` / `close` events.
 */
function createFakeChild(pid: number | undefined) {
  return Object.assign(new EventEmitter(), {
    pid,
    kill: vi.fn(() => true),
    stdout: new EventEmitter(),
    stderr: new EventEmitter(),
  });
}

/** Makes a fake child report a clean exit on the next turn of the loop. */
function emitClose(child: ReturnType<typeof createFakeChild>) {
  setImmediate(() => {
    child.emit('exit', 0, null);
    child.emit('close', 0, null);
  });
  return child;
}

function spyOnProcessKill() {
  return vi.spyOn(process, 'kill').mockImplementation(() => true);
}

/** Reports whether `pid` is alive without reading /proc, which macOS lacks. */
function isAlive(pid: number): boolean {
  try {
    return process.kill(pid, 0);
  } catch {
    return false;
  }
}

async function waitForExit(pid: number, timeoutMs = 10000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (isAlive(pid)) {
    if (Date.now() > deadline) {
      expect.fail(`Process ${pid} was still alive after ${timeoutMs}ms.`);
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

/** Reads a pid the executed script reported through an output file. */
function readPid(result: CodeExecutionResult, name: string): number {
  const file = result.outputFiles?.find((f) => f.name === name);
  if (!file) {
    expect.fail(`The script reported no ${name}; stderr: ${result.stderr}`);
  }
  return Number(file.content);
}

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
            contentEncoding: 'base64',
            mimeType: 'text/plain',
          },
          {
            name: 'subdir/data.json',
            content: '{"key": "value"}',
            contentEncoding: 'utf8',
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
            contentEncoding: 'base64',
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
  });

  describe('process group teardown', () => {
    let killSpy: ReturnType<typeof spyOnProcessKill>;

    beforeEach(() => {
      killSpy = spyOnProcessKill();
    });

    afterEach(() => {
      vi.useRealTimers();
      killSpy.mockRestore();
    });

    function jsParams(code: string): ExecuteCodeParams {
      return {
        invocationContext,
        codeExecutionInput: {
          code,
          language: CodeExecutionLanguage.JAVASCRIPT,
          inputFiles: [],
        },
      };
    }

    /**
     * Advances the fake clock until the executor has spawned, so the test can
     * drive the fake child. The executor awaits real filesystem work first,
     * which only progresses when the async timer helpers yield to the event
     * loop.
     */
    async function waitForSpawn(): Promise<void> {
      for (let i = 0; i < 100 && spawnMock.mock.calls.length === 0; i++) {
        await vi.advanceTimersByTimeAsync(0);
      }
      expect(spawnMock).toHaveBeenCalled();
    }

    it.skipIf(IS_WINDOWS)(
      'should spawn the script detached so it leads its own process group',
      async () => {
        spawnMock.mockImplementation(() => emitClose(createFakeChild(4321)));

        await executor.executeCode(jsParams('console.log("hi");'));

        expect(spawnMock).toHaveBeenCalledWith(
          process.execPath,
          expect.anything(),
          expect.objectContaining({detached: true, cwd: expect.any(String)}),
        );
      },
    );

    it.skipIf(!IS_WINDOWS)(
      'should not spawn the script detached on Windows, which has no process groups',
      async () => {
        spawnMock.mockImplementation(() => emitClose(createFakeChild(4321)));

        await executor.executeCode(jsParams('console.log("hi");'));

        expect(spawnMock.mock.calls[0][2].detached).toBeFalsy();
      },
    );

    it('should not pass a spawn timeout, which would kill the script alone', async () => {
      spawnMock.mockImplementation(() => emitClose(createFakeChild(4321)));

      await executor.executeCode(jsParams('console.log("hi");'));

      expect(spawnMock.mock.calls[0][2]).not.toHaveProperty('timeout');
    });

    it.skipIf(IS_WINDOWS)(
      'should signal the group when the script completes normally',
      async () => {
        spawnMock.mockImplementation(() => emitClose(createFakeChild(4321)));

        const result = await executor.executeCode(
          jsParams('console.log("hi");'),
        );

        expect(killSpy).toHaveBeenCalledWith(-4321, 'SIGTERM');
        expect(result.stderr).toBe('');
      },
    );

    it('should report a non-zero exit code the script gave no message for', async () => {
      spawnMock.mockImplementation(() => {
        const child = createFakeChild(4321);
        setImmediate(() => {
          child.emit('exit', 3, null);
          child.emit('close', 3, null);
        });
        return child;
      });

      const result = await executor.executeCode(jsParams('process.exit(3);'));

      expect(result.stderr).toBe('Exit code 3');
    });

    it.skipIf(IS_WINDOWS)(
      'should ignore child events that arrive after the call settled',
      async () => {
        vi.useFakeTimers();
        const child = createFakeChild(4321);
        spawnMock.mockImplementation(() => child);

        const execution = executor.executeCode(jsParams('console.log("hi");'));
        await waitForSpawn();
        child.emit('close', 0, null);
        const result = await execution;

        // Late events must not restart the teardown: the group id may already
        // belong to an unrelated process.
        child.emit('exit', 0, null);
        child.emit('close', 9, null);
        await vi.advanceTimersByTimeAsync(TERMINATE_GRACE_MS * 2);

        expect(killSpy).not.toHaveBeenCalled();
        expect(result.stderr).toBe('');
        expect(vi.getTimerCount()).toBe(0);
      },
    );

    it.skipIf(IS_WINDOWS)(
      'should clear its timers and stop signalling once the call settles',
      async () => {
        vi.useFakeTimers();
        const child = createFakeChild(4321);
        spawnMock.mockImplementation(() => child);

        const execution = executor.executeCode(jsParams('console.log("hi");'));
        await waitForSpawn();
        child.emit('exit', 0, null);
        child.emit('close', 0, null);
        await execution;

        // A live escalation timer would hold the event loop and could signal a
        // process group id that the operating system has since reused.
        expect(vi.getTimerCount()).toBe(0);

        await vi.advanceTimersByTimeAsync(TERMINATE_GRACE_MS * 2);

        expect(killSpy.mock.calls).toEqual([[-4321, 'SIGTERM']]);
      },
    );

    it.skipIf(IS_WINDOWS)(
      'should escalate to SIGKILL when the group outlives the grace period',
      async () => {
        vi.useFakeTimers();
        const child = createFakeChild(4321);
        spawnMock.mockImplementation(() => child);

        const execution = executor.executeCode(jsParams('console.log("hi");'));
        await waitForSpawn();
        // `close` never arrives: something in the group still holds the pipes.
        child.emit('exit', 0, null);
        await vi.advanceTimersByTimeAsync(0);

        expect(killSpy.mock.calls).toEqual([[-4321, 'SIGTERM']]);

        await vi.advanceTimersByTimeAsync(TERMINATE_GRACE_MS);
        await execution;

        expect(killSpy.mock.calls).toEqual([
          [-4321, 'SIGTERM'],
          [-4321, 'SIGKILL'],
        ]);
      },
    );

    it.skipIf(IS_WINDOWS)(
      'should signal the group and report the timeout when the script runs too long',
      async () => {
        vi.useFakeTimers();
        const child = createFakeChild(9876);
        spawnMock.mockImplementation(() => child);
        const shortTimeoutExecutor = new UnsafeLocalCodeExecutor({
          timeoutSeconds: 1,
        });

        const execution = shortTimeoutExecutor.executeCode(
          jsParams('setTimeout(() => {}, 60000);'),
        );
        await waitForSpawn();
        await vi.advanceTimersByTimeAsync(1000);

        expect(killSpy.mock.calls).toEqual([[-9876, 'SIGTERM']]);

        await vi.advanceTimersByTimeAsync(TERMINATE_GRACE_MS);
        const result = await execution;

        expect(killSpy.mock.calls).toEqual([
          [-9876, 'SIGTERM'],
          [-9876, 'SIGKILL'],
        ]);
        expect(result.stderr).toContain(
          'Code execution timed out after 1 seconds.',
        );
      },
    );

    it.skipIf(IS_WINDOWS)(
      'should treat an already empty group as success',
      async () => {
        killSpy.mockImplementation(() => {
          throw new Error('kill ESRCH');
        });
        spawnMock.mockImplementation(() => {
          const child = createFakeChild(4321);
          setImmediate(() => {
            child.stdout.emit('data', Buffer.from('hi'));
            child.emit('exit', 0, null);
            child.emit('close', 0, null);
          });
          return child;
        });

        const result = await executor.executeCode(
          jsParams('console.log("hi");'),
        );

        expect(result.stdout).toBe('hi');
        expect(result.stderr).toBe('');
      },
    );

    it('should signal no group when spawn produced no pid', async () => {
      spawnMock.mockImplementation(() => {
        const child = createFakeChild(undefined);
        setImmediate(() => {
          child.emit('error', new Error('spawn ENOENT'));
          child.emit('close', null, null);
        });
        return child;
      });

      const result = await executor.executeCode(jsParams('console.log("hi");'));

      expect(killSpy).not.toHaveBeenCalled();
      expect(result.stderr).toContain('Process error:');
    });

    it('should terminate the script alone when it has no process group', async () => {
      const child = createFakeChild(undefined);
      spawnMock.mockImplementation(() => emitClose(child));

      await executor.executeCode(jsParams('console.log("hi");'));

      expect(child.kill).toHaveBeenCalledWith('SIGTERM');
      expect(killSpy).not.toHaveBeenCalled();
    });
  });

  // Real processes, so these prove the group teardown works rather than that
  // the executor calls the right functions.
  describe.skipIf(IS_WINDOWS)('process group teardown (real processes)', () => {
    it(
      'should kill a background process the script left behind',
      async () => {
        const result = await executor.executeCode({
          invocationContext,
          codeExecutionInput: {
            code: backgroundChildScript('ignore'),
            language: CodeExecutionLanguage.JAVASCRIPT,
            inputFiles: [],
          },
        });

        expect(result.stderr).toBe('');
        await waitForExit(readPid(result, BACKGROUND_PID_FILE));
      },
      REAL_PROCESS_TIMEOUT_MS,
    );

    it(
      'should settle when a background process holds the stdio pipes',
      async () => {
        const result = await executor.executeCode({
          invocationContext,
          codeExecutionInput: {
            code: backgroundChildScript(
              'inherit',
              'console.log("script done");',
            ),
            language: CodeExecutionLanguage.JAVASCRIPT,
            inputFiles: [],
          },
        });

        expect(result.stdout).toContain('script done');
        await waitForExit(readPid(result, BACKGROUND_PID_FILE));
      },
      REAL_PROCESS_TIMEOUT_MS,
    );

    it(
      'should kill a background process when the script times out',
      async () => {
        const shortTimeoutExecutor = new UnsafeLocalCodeExecutor({
          timeoutSeconds: 1,
        });

        const result = await shortTimeoutExecutor.executeCode({
          invocationContext,
          codeExecutionInput: {
            code: backgroundChildScript(
              'ignore',
              'setTimeout(() => {}, 60000);',
            ),
            language: CodeExecutionLanguage.JAVASCRIPT,
            inputFiles: [],
          },
        });

        expect(result.stderr).toContain(
          'Code execution timed out after 1 seconds.',
        );
        await waitForExit(readPid(result, BACKGROUND_PID_FILE));
      },
      REAL_PROCESS_TIMEOUT_MS,
    );

    it(
      'should kill a grandchild the script never held a handle to',
      async () => {
        const result = await executor.executeCode({
          invocationContext,
          codeExecutionInput: {
            code: GRANDCHILD_SCRIPT,
            language: CodeExecutionLanguage.JAVASCRIPT,
            inputFiles: [],
          },
        });

        expect(result.stderr).toBe('');
        await waitForExit(readPid(result, GRANDCHILD_PID_FILE));
      },
      REAL_PROCESS_TIMEOUT_MS,
    );
  });
});
