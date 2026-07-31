/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  CodeExecutionLanguage,
  ExecuteCodeParams,
  InvocationContext,
  LlmAgent,
  PluginManager,
  UnsafeLocalCodeExecutor,
  createSession,
} from '@google/adk';
import {EventEmitter} from 'node:events';
import * as os from 'node:os';
import {Readable} from 'node:stream';
import {beforeEach, describe, expect, it, vi} from 'vitest';

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

/**
 * Fixture text whose characters are 3 and 4 bytes wide. The unit is 25 bytes
 * and `PIPE_CHUNK_BYTES` is not a multiple of it, so pipe read boundaries land
 * inside a UTF-8 sequence rather than between two of them.
 */
const MULTI_BYTE_UNIT = '日本語テキスト🙂';
const MULTI_BYTE_REPEATS = 32768;
const MULTI_BYTE_TEXT = MULTI_BYTE_UNIT.repeat(MULTI_BYTE_REPEATS);
const REPLACEMENT_CHARACTER = '\uFFFD';

/**
 * Bytes per simulated pipe read, matching the 64 KiB a real pipe hands over
 * at once.
 */
const PIPE_CHUNK_BYTES = 65536;

/**
 * Headroom for the real-subprocess cases: spawning `node` and moving 800 KiB
 * through a pipe can outrun Vitest's 5s default on a loaded machine.
 */
const REAL_SUBPROCESS_TIMEOUT_MS = 20000;

/** A child process whose stdio pipes are real `Readable`s. */
type ChunkedChildProcess = EventEmitter & {stdout: Readable; stderr: Readable};

/** Splits `text` into the byte-sized reads a pipe would deliver. */
function pipeChunks(text: string): Buffer[] {
  const bytes = Buffer.from(text, 'utf-8');
  const chunks: Buffer[] = [];
  for (let offset = 0; offset < bytes.length; offset += PIPE_CHUNK_BYTES) {
    chunks.push(bytes.subarray(offset, offset + PIPE_CHUNK_BYTES));
  }
  return chunks;
}

/** A readable that emits exactly one of `chunks` per 'data' event. */
function chunkedStream(chunks: readonly Buffer[]): Readable {
  let next = 0;
  return new Readable({
    read() {
      // Pushed asynchronously: chunks pushed synchronously during the first
      // read stay in the internal buffer, which Readable.read() then hands
      // over as one concatenated 'data' event, hiding the boundary under test.
      setImmediate(() => {
        this.push(next < chunks.length ? chunks[next++] : null);
      });
    },
  });
}

/**
 * A child that delivers `stdoutText` and `stderrText` one pipe read at a time,
 * closing only once both streams have ended so no output can be missed.
 */
function createChunkedChild(
  stdoutText: string,
  stderrText: string,
): ChunkedChildProcess {
  const stdout = chunkedStream(pipeChunks(stdoutText));
  const stderr = chunkedStream(pipeChunks(stderrText));
  const child: ChunkedChildProcess = Object.assign(new EventEmitter(), {
    stdout,
    stderr,
  });

  let endedStreams = 0;
  const onEnd = () => {
    if (++endedStreams === 2) {
      child.emit('close', 0, null);
    }
  };
  stdout.on('end', onEnd);
  stderr.on('end', onEnd);

  return child;
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

  describe('multi-byte output', () => {
    it('should not corrupt multi-byte stdout split across pipe read boundaries', async () => {
      spawnMock.mockImplementation(() =>
        createChunkedChild(MULTI_BYTE_TEXT, ''),
      );

      const result = await executor.executeCode({
        invocationContext,
        codeExecutionInput: {
          // The child is faked, so the script itself is never run.
          code: '',
          language: CodeExecutionLanguage.JAVASCRIPT,
          inputFiles: [],
        },
      });

      expect(result.stdout.indexOf(REPLACEMENT_CHARACTER)).toBe(-1);
      expect(result.stdout).toBe(MULTI_BYTE_TEXT);
    });

    it('should not corrupt multi-byte stderr split across pipe read boundaries', async () => {
      spawnMock.mockImplementation(() =>
        createChunkedChild('', MULTI_BYTE_TEXT),
      );

      const result = await executor.executeCode({
        invocationContext,
        codeExecutionInput: {
          // The child is faked, so the script itself is never run.
          code: '',
          language: CodeExecutionLanguage.JAVASCRIPT,
          inputFiles: [],
        },
      });

      expect(result.stderr.indexOf(REPLACEMENT_CHARACTER)).toBe(-1);
      expect(result.stderr).toBe(MULTI_BYTE_TEXT);
      expect(result.stdout).toBe('');
    });

    it(
      'should round-trip a large multi-byte stdout from a real subprocess',
      async () => {
        const result = await executor.executeCode({
          invocationContext,
          codeExecutionInput: {
            code: `process.stdout.write(${JSON.stringify(MULTI_BYTE_UNIT)}.repeat(${MULTI_BYTE_REPEATS}));`,
            language: CodeExecutionLanguage.JAVASCRIPT,
            inputFiles: [],
          },
        });

        expect(result.stdout.indexOf(REPLACEMENT_CHARACTER)).toBe(-1);
        expect(result.stdout).toBe(MULTI_BYTE_TEXT);
        expect(result.stderr).toBe('');
      },
      REAL_SUBPROCESS_TIMEOUT_MS,
    );

    it(
      'should round-trip a large multi-byte stderr from a real subprocess',
      async () => {
        const result = await executor.executeCode({
          invocationContext,
          codeExecutionInput: {
            code: `process.stderr.write(${JSON.stringify(MULTI_BYTE_UNIT)}.repeat(${MULTI_BYTE_REPEATS}));`,
            language: CodeExecutionLanguage.JAVASCRIPT,
            inputFiles: [],
          },
        });

        expect(result.stderr.indexOf(REPLACEMENT_CHARACTER)).toBe(-1);
        expect(result.stderr).toBe(MULTI_BYTE_TEXT);
        expect(result.stdout).toBe('');
      },
      REAL_SUBPROCESS_TIMEOUT_MS,
    );
  });
});
