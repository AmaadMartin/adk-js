/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  CloudRunSandboxCodeExecutor,
  CodeExecutionLanguage,
  ExecuteCodeParams,
  InvocationContext,
  LlmAgent,
  PluginManager,
  createSession,
} from '@google/adk';
import {EventEmitter} from 'node:events';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {beforeEach, describe, expect, it, vi} from 'vitest';

const spawnMock = vi.hoisted(() => vi.fn());
vi.mock('node:child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:child_process')>()),
  spawn: spawnMock,
}));

const {spawn: realSpawn} =
  await vi.importActual<typeof import('node:child_process')>(
    'node:child_process',
  );

const DEFAULT_SANDBOX_BIN = '/usr/local/gcp/bin/sandbox';

/** How long the stand-in sandbox and the process that outlives it stay up. */
const SURVIVOR_LIFETIME_MS = 5000;

/**
 * What the stand-in sandbox case allows for a `timeoutSeconds: 1` run: the
 * timeout, the stdio drain, and slack for a loaded CI runner. Well under
 * {@link SURVIVOR_LIFETIME_MS}, so an unbounded wait fails the assertion
 * rather than the runner's own budget.
 */
const BOUNDED_RETURN_BUDGET_MS = 3000;

/** Budget for the stand-in sandbox case, which spawns real processes. */
const REAL_SANDBOX_TEST_TIMEOUT_MS = 15000;

/**
 * Writes an executable stand-in for the guest `sandbox` binary that reproduces
 * the one behaviour that matters here: it supervises the interpreter in a
 * separate process, so killing the stand-in leaves that process alive holding
 * the inherited pipes.
 */
async function writeForkingSandbox(dir: string): Promise<string> {
  const sandboxBin = path.join(dir, 'fake_sandbox');
  await fs.writeFile(
    sandboxBin,
    [
      `#!${process.execPath}`,
      "const {spawn} = require('node:child_process');",
      "process.stdout.write('partial output\\n');",
      `spawn(process.execPath, ['-e', 'setTimeout(() => {}, ${SURVIVOR_LIFETIME_MS})'], {stdio: 'inherit'});`,
      `setTimeout(() => {}, ${SURVIVOR_LIFETIME_MS});`,
    ].join('\n'),
    {mode: 0o755},
  );
  return sandboxBin;
}

interface FakeChildOptions {
  /** Chunks emitted on the child's stdout before it exits. */
  stdout?: string;
  /** Chunks emitted on the child's stderr before it exits. */
  stderr?: string;
  /** Exit code reported by the `exit` and `close` events. */
  exitCode?: number | null;
  /** Signal reported by the `exit` and `close` events. */
  signal?: 'SIGKILL' | null;
  /** Emitted on the child itself, in place of `exit`, when set. */
  spawnError?: Error;
  /** Emitted on the child's stdin, before it exits, when set. */
  stdinError?: Error;
  /**
   * Withholds `close`, as Node does while a process that outlived the child
   * still holds the inherited pipes open.
   */
  pipesHeldOpen?: boolean;
}

/**
 * Installs a fake child process for the next `spawn` call and returns its
 * stdin, so a test can assert the program that was piped into the sandbox.
 *
 * The streams are plain `EventEmitter`s rather than `PassThrough`s because
 * `emit` is synchronous: `data` is therefore always delivered before `exit`.
 */
function mockSpawn(options: FakeChildOptions = {}): {
  end: ReturnType<typeof vi.fn>;
} {
  const stdin = Object.assign(new EventEmitter(), {end: vi.fn()});
  spawnMock.mockImplementation(() => {
    const child = Object.assign(new EventEmitter(), {
      stdout: Object.assign(new EventEmitter(), {
        setEncoding: vi.fn(),
        destroy: vi.fn(),
      }),
      stderr: Object.assign(new EventEmitter(), {
        setEncoding: vi.fn(),
        destroy: vi.fn(),
      }),
      stdin,
    });
    setImmediate(() => {
      if (options.stdout !== undefined) {
        child.stdout.emit('data', options.stdout);
      }
      if (options.stderr !== undefined) {
        child.stderr.emit('data', options.stderr);
      }
      if (options.stdinError !== undefined) {
        stdin.emit('error', options.stdinError);
      }
      const exitCode = options.exitCode ?? 0;
      const signal = options.signal ?? null;
      // A failed spawn reports 'error' and then 'close', never 'exit'.
      if (options.spawnError !== undefined) {
        child.emit('error', options.spawnError);
      } else {
        child.emit('exit', exitCode, signal);
      }
      if (!options.pipesHeldOpen) {
        child.emit('close', exitCode, signal);
      }
    });
    return child;
  });
  return stdin;
}

function createInvocationContext(): InvocationContext {
  return new InvocationContext({
    invocationId: 'test-invocation',
    agent: new LlmAgent({name: 'test_agent', model: 'gemini-2.5-flash'}),
    session: createSession({
      id: 'test-session',
      events: [],
      appName: 'test-app',
      userId: 'test-user',
    }),
    pluginManager: new PluginManager([]),
  });
}

const invocationContext = createInvocationContext();

function params(code: string): ExecuteCodeParams {
  return {
    invocationContext,
    codeExecutionInput: {
      code,
      language: CodeExecutionLanguage.PYTHON,
      inputFiles: [],
    },
  };
}

describe('CloudRunSandboxCodeExecutor', () => {
  beforeEach(() => {
    spawnMock.mockReset();
  });

  it('defaults to a non-stateful executor that runs the current interpreter', async () => {
    const executor = new CloudRunSandboxCodeExecutor();
    expect(executor.stateful).toBe(false);
    expect(executor.optimizeDataFile).toBe(false);

    mockSpawn();
    await executor.executeCode(params('print("hi")'));

    expect(spawnMock).toHaveBeenCalledTimes(1);
    expect(spawnMock).toHaveBeenCalledWith(
      DEFAULT_SANDBOX_BIN,
      ['do', process.execPath],
      expect.objectContaining({timeout: undefined, killSignal: 'SIGKILL'}),
    );
  });

  it('rejects stateful: true', () => {
    expect(() => new CloudRunSandboxCodeExecutor({stateful: true})).toThrow(
      'Cannot set `stateful: true` in CloudRunSandboxCodeExecutor.',
    );
  });

  it('rejects optimizeDataFile: true', () => {
    expect(
      () => new CloudRunSandboxCodeExecutor({optimizeDataFile: true}),
    ).toThrow(
      'Cannot set `optimizeDataFile: true` in CloudRunSandboxCodeExecutor.',
    );
  });

  it('returns the sandbox stdout and pipes the code to stdin', async () => {
    const stdin = mockSpawn({stdout: 'hello world\n'});

    const result = await new CloudRunSandboxCodeExecutor().executeCode(
      params('print("hello world")'),
    );

    expect(result).toEqual({
      stdout: 'hello world\n',
      stderr: '',
      outputFiles: [],
    });
    expect(stdin.end).toHaveBeenCalledWith('print("hello world")');
  });

  it('places --allow-egress between do and the interpreter, and converts the timeout to milliseconds', async () => {
    mockSpawn({stdout: 'egress success\n'});

    const result = await new CloudRunSandboxCodeExecutor({
      sandboxBin: '/usr/bin/custom-sandbox',
      allowEgress: true,
      timeoutSeconds: 10,
    }).executeCode(params("import requests; print('ok')"));

    expect(result.stdout).toBe('egress success\n');
    expect(spawnMock).toHaveBeenCalledWith(
      '/usr/bin/custom-sandbox',
      ['do', '--allow-egress', process.execPath],
      expect.objectContaining({timeout: 10_000}),
    );
  });

  it('runs the configured interpreterPath', async () => {
    mockSpawn();

    await new CloudRunSandboxCodeExecutor({
      interpreterPath: '/usr/bin/python3',
    }).executeCode(params('print("hi")'));

    expect(spawnMock).toHaveBeenCalledWith(
      DEFAULT_SANDBOX_BIN,
      ['do', '/usr/bin/python3'],
      expect.anything(),
    );
  });

  it('drops the netns teardown warnings and the trailing newline from stderr', async () => {
    mockSpawn({
      stderr: [
        'Failed to cleanup network namespace: sandbox-1',
        'real warning',
        'sandbox: failed to unmount netns file',
        '',
      ].join('\n'),
    });

    const result = await new CloudRunSandboxCodeExecutor().executeCode(
      params('print("hi")'),
    );

    expect(result.stderr).toBe('real warning');
  });

  it('returns the child stderr on a non-zero exit without adding an exit-code message', async () => {
    mockSpawn({
      stderr: 'Traceback ... ValueError: Test error\n',
      exitCode: 1,
    });

    const result = await new CloudRunSandboxCodeExecutor().executeCode(
      params('raise ValueError("Test error")'),
    );

    expect(result.stdout).toBe('');
    expect(result.stderr).toBe('Traceback ... ValueError: Test error');
  });

  it('reports a timeout when the killed child wrote no stderr', async () => {
    mockSpawn({stdout: 'partial stdout', exitCode: null, signal: 'SIGKILL'});

    const result = await new CloudRunSandboxCodeExecutor({
      timeoutSeconds: 5,
    }).executeCode(params('import time\ntime.sleep(10)'));

    expect(result).toEqual({
      stdout: 'partial stdout',
      stderr: 'Code execution timed out after 5 seconds.',
      outputFiles: [],
    });
  });

  it('keeps the stderr captured before a timeout', async () => {
    mockSpawn({
      stdout: 'partial stdout',
      stderr: 'partial stderr',
      exitCode: null,
      signal: 'SIGKILL',
    });

    const result = await new CloudRunSandboxCodeExecutor({
      timeoutSeconds: 5,
    }).executeCode(params('import time\ntime.sleep(10)'));

    expect(result.stdout).toBe('partial stdout');
    expect(result.stderr).toBe('partial stderr');
  });

  it('leaves no drain timer pending once close arrives', async () => {
    // setImmediate stays real so the fake child still emits its events.
    vi.useFakeTimers({toFake: ['setTimeout', 'clearTimeout']});
    try {
      mockSpawn({exitCode: null, signal: 'SIGKILL'});

      await new CloudRunSandboxCodeExecutor({timeoutSeconds: 5}).executeCode(
        params('import time\ntime.sleep(10)'),
      );

      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('reports a timed-out run whose close never arrives', async () => {
    mockSpawn({
      stdout: 'partial stdout',
      exitCode: null,
      signal: 'SIGKILL',
      pipesHeldOpen: true,
    });

    const result = await new CloudRunSandboxCodeExecutor({
      timeoutSeconds: 5,
    }).executeCode(params('import time\ntime.sleep(10)'));

    expect(result).toEqual({
      stdout: 'partial stdout',
      stderr: 'Code execution timed out after 5 seconds.',
      outputFiles: [],
    });
  });

  it('names the configured binary when the sandbox binary is missing', async () => {
    mockSpawn({
      spawnError: Object.assign(new Error('spawn sandbox ENOENT'), {
        code: 'ENOENT',
      }),
      exitCode: -2,
    });

    const result = await new CloudRunSandboxCodeExecutor({
      sandboxBin: '/opt/missing-sandbox',
    }).executeCode(params('print("hi")'));

    expect(result).toEqual({
      stdout: '',
      stderr:
        'Sandbox binary "/opt/missing-sandbox" not found. Ensure you are ' +
        'running in an environment with the sandbox tool installed.',
      outputFiles: [],
    });
  });

  it('reports a spawn error that carries no error code', async () => {
    mockSpawn({spawnError: new Error('boom'), exitCode: -1});

    const result = await new CloudRunSandboxCodeExecutor().executeCode(
      params('print("hi")'),
    );

    expect(result).toEqual({
      stdout: '',
      stderr: 'Unexpected error running sandbox: boom',
      outputFiles: [],
    });
  });

  it('reports a spawn error whose code is not ENOENT', async () => {
    mockSpawn({
      spawnError: Object.assign(new Error('spawn sandbox EACCES'), {
        code: 'EACCES',
      }),
      exitCode: -13,
    });

    const result = await new CloudRunSandboxCodeExecutor().executeCode(
      params('print("hi")'),
    );

    expect(result.stderr).toBe(
      'Unexpected error running sandbox: spawn sandbox EACCES',
    );
  });

  it('survives an EPIPE on stdin and returns the child result', async () => {
    mockSpawn({
      stdout: 'done\n',
      stdinError: Object.assign(new Error('write EPIPE'), {code: 'EPIPE'}),
    });

    const result = await new CloudRunSandboxCodeExecutor().executeCode(
      params('print("done")'),
    );

    expect(result).toEqual({stdout: 'done\n', stderr: '', outputFiles: []});
  });

  it('reports a synchronous spawn failure', async () => {
    spawnMock.mockImplementation(() => {
      throw new Error('boom');
    });

    const result = await new CloudRunSandboxCodeExecutor().executeCode(
      params('print("hi")'),
    );

    expect(result).toEqual({
      stdout: '',
      stderr: 'Unexpected error running sandbox: boom',
      outputFiles: [],
    });
  });

  // Node refuses to spawn a `.cmd` or `.bat` without a shell, so there is no
  // portable executable stand-in for the guest binary on Windows. The mocked
  // case above pins the same drain path on every platform.
  it.runIf(os.platform() !== 'win32')(
    'bounds a timed-out run by timeoutSeconds, not by the survivor holding the pipes',
    async () => {
      spawnMock.mockImplementation(realSpawn);
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'adk_js_crs_test_'));
      try {
        const startedAt = Date.now();

        const result = await new CloudRunSandboxCodeExecutor({
          sandboxBin: await writeForkingSandbox(dir),
          timeoutSeconds: 1,
        }).executeCode(params('print("hi")'));

        expect(Date.now() - startedAt).toBeLessThan(BOUNDED_RETURN_BUDGET_MS);
        expect(result).toEqual({
          stdout: 'partial output\n',
          stderr: 'Code execution timed out after 1 seconds.',
          outputFiles: [],
        });
      } finally {
        await fs.rm(dir, {recursive: true, force: true});
      }
    },
    REAL_SANDBOX_TEST_TIMEOUT_MS,
  );

  // Drives the real `node:child_process.spawn`, so it covers the whole path
  // an agent takes outside a sandbox-enabled Cloud Run container.
  it('returns the not-found result from an unmocked spawn of an absent binary', async () => {
    spawnMock.mockImplementation(realSpawn);
    const sandboxBin = path.join(os.tmpdir(), 'adk_js_absent_sandbox_binary');

    const result = await new CloudRunSandboxCodeExecutor({
      sandboxBin,
    }).executeCode(params('print("hi")'));

    expect(result).toEqual({
      stdout: '',
      stderr:
        `Sandbox binary "${sandboxBin}" not found. Ensure you are running ` +
        'in an environment with the sandbox tool installed.',
      outputFiles: [],
    });
  });
});
