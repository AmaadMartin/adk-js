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
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {beforeEach, describe, expect, it, vi} from 'vitest';
import {
  InterpreterCommands,
  createTempScriptFile,
  getExtensionForLanguage,
  resolveInterpreterDefaults,
  resolveSpawnCommand,
} from '../../src/code_executors/unsafe_local_code_executor.js';

// Only `spawn` is mocked; it defaults to the real implementation (see
// `beforeEach`) so the pre-existing tests still execute real scripts.
const spawnMock = vi.hoisted(() => vi.fn());
vi.mock('node:child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:child_process')>()),
  spawn: spawnMock,
}));

// Likewise for `readdir`: only the output-file scan failure test overrides it.
const readdirMock = vi.hoisted(() => vi.fn());
vi.mock('node:fs/promises', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:fs/promises')>()),
  readdir: readdirMock,
}));

const {spawn: realSpawn} =
  await vi.importActual<typeof import('node:child_process')>(
    'node:child_process',
  );

const {readdir: realReaddir} =
  await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');

const POWERSHELL_COMMAND = os.platform() === 'win32' ? 'powershell' : 'pwsh';

const POWERSHELL_FLAGS = [
  '-NoLogo',
  '-NoProfile',
  '-ExecutionPolicy',
  'Bypass',
  '-File',
];

const CMD_FLAGS = ['/D', '/c'];

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
    readdirMock.mockReset();
    readdirMock.mockImplementation(realReaddir);
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

  it('should report the exit code when a failing script writes nothing to stderr', async () => {
    const params: ExecuteCodeParams = {
      invocationContext,
      codeExecutionInput: {
        code: 'process.exit(3);',
        language: CodeExecutionLanguage.JAVASCRIPT,
        inputFiles: [],
      },
    };

    const result = await executor.executeCode(params);

    expect(result.stderr).toBe('Exit code 3');
  });

  it('should still return the script output when the output file scan fails', async () => {
    readdirMock.mockRejectedValueOnce(new Error('scan failed'));
    const params: ExecuteCodeParams = {
      invocationContext,
      codeExecutionInput: {
        code: 'const fs = require("fs"); fs.writeFileSync("out.txt", "x"); console.log("ran anyway");',
        language: CodeExecutionLanguage.JAVASCRIPT,
        inputFiles: [],
      },
    };

    const result = await executor.executeCode(params);

    expect(result.stdout).toContain('ran anyway');
    expect(result.stderr).toBe('');
    expect(result.outputFiles).toEqual([]);
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
});

// The helpers below take the platform as an argument, so every arm is reachable
// on every host. That is what keeps `npm run test:coverage` from reporting
// different totals on ubuntu, macos and windows.
describe('platform-independent resolution', () => {
  const COMMANDS: InterpreterCommands = {
    node: 'node-command',
    python: 'python-command',
    shell: 'shell-command',
  };
  const SCRIPT = path.join('tmp', 'script.txt');

  describe('getExtensionForLanguage', () => {
    it.each([false, true])(
      'maps the non-shell languages to a fixed extension when isWindows is %s',
      (isWindows) => {
        expect(
          getExtensionForLanguage(
            CodeExecutionLanguage.JAVASCRIPT,
            undefined,
            isWindows,
          ),
        ).toBe('.js');
        expect(
          getExtensionForLanguage(
            CodeExecutionLanguage.PYTHON,
            undefined,
            isWindows,
          ),
        ).toBe('.py');
        expect(
          getExtensionForLanguage(
            CodeExecutionLanguage.POWERSHELL,
            undefined,
            isWindows,
          ),
        ).toBe('.ps1');
        expect(
          getExtensionForLanguage(
            CodeExecutionLanguage.WINDOWS_CMD,
            undefined,
            isWindows,
          ),
        ).toBe('.bat');
      },
    );

    it.each([false, true])(
      'returns no extension for an unsupported language when isWindows is %s',
      (isWindows) => {
        expect(
          getExtensionForLanguage(
            CodeExecutionLanguage.UNSPECIFIED,
            undefined,
            isWindows,
          ),
        ).toBeUndefined();
      },
    );

    it('writes shell code to a .sh script off Windows', () => {
      expect(
        getExtensionForLanguage(CodeExecutionLanguage.SHELL, 'bash', false),
      ).toBe('.sh');
    });

    it('writes shell code to a .ps1 script on Windows', () => {
      expect(
        getExtensionForLanguage(
          CodeExecutionLanguage.SHELL,
          'powershell',
          true,
        ),
      ).toBe('.ps1');
    });

    it('writes shell code to a .bat script on Windows when the shell is cmd', () => {
      expect(
        getExtensionForLanguage(CodeExecutionLanguage.SHELL, 'CMD.EXE', true),
      ).toBe('.bat');
    });

    it('writes shell code to a .ps1 script on Windows when no shell command is set', () => {
      expect(
        getExtensionForLanguage(CodeExecutionLanguage.SHELL, undefined, true),
      ).toBe('.ps1');
    });
  });

  describe('resolveInterpreterDefaults', () => {
    it('defaults to python3 and bash off Windows', () => {
      expect(resolveInterpreterDefaults({}, false)).toEqual({
        node: process.execPath,
        python: 'python3',
        shell: 'bash',
      });
    });

    it('defaults to python and powershell on Windows', () => {
      expect(resolveInterpreterDefaults({}, true)).toEqual({
        node: process.execPath,
        python: 'python',
        shell: 'powershell',
      });
    });

    it.each([false, true])(
      'prefers the caller commands over the defaults when isWindows is %s',
      (isWindows) => {
        expect(
          resolveInterpreterDefaults(
            {
              commandPath: 'my-node',
              pythonCommandPath: 'py',
              shellCommandPath: 'zsh',
            },
            isWindows,
          ),
        ).toEqual({node: 'my-node', python: 'py', shell: 'zsh'});
      },
    );
  });

  describe('resolveSpawnCommand', () => {
    it.each([false, true])(
      'runs javascript through the node command when isWindows is %s',
      (isWindows) => {
        expect(
          resolveSpawnCommand(
            CodeExecutionLanguage.JAVASCRIPT,
            SCRIPT,
            COMMANDS,
            isWindows,
          ),
        ).toEqual({command: 'node-command', args: [SCRIPT]});
      },
    );

    it.each([false, true])(
      'runs python through the python command when isWindows is %s',
      (isWindows) => {
        expect(
          resolveSpawnCommand(
            CodeExecutionLanguage.PYTHON,
            SCRIPT,
            COMMANDS,
            isWindows,
          ),
        ).toEqual({command: 'python-command', args: [SCRIPT]});
      },
    );

    it.each([false, true])(
      'runs shell code through the shell command with no flags when it is neither powershell nor cmd, isWindows is %s',
      (isWindows) => {
        expect(
          resolveSpawnCommand(
            CodeExecutionLanguage.SHELL,
            SCRIPT,
            {...COMMANDS, shell: 'bash'},
            isWindows,
          ),
        ).toEqual({command: 'bash', args: [SCRIPT]});
      },
    );

    it.each([false, true])(
      'adds the powershell flags when the shell command is powershell, isWindows is %s',
      (isWindows) => {
        expect(
          resolveSpawnCommand(
            CodeExecutionLanguage.SHELL,
            SCRIPT,
            {...COMMANDS, shell: 'C:\\Windows\\PowerShell.exe'},
            isWindows,
          ),
        ).toEqual({
          command: 'C:\\Windows\\PowerShell.exe',
          args: [...POWERSHELL_FLAGS, SCRIPT],
        });
      },
    );

    it.each([false, true])(
      'adds the cmd flags when the shell command is cmd, isWindows is %s',
      (isWindows) => {
        expect(
          resolveSpawnCommand(
            CodeExecutionLanguage.SHELL,
            SCRIPT,
            {...COMMANDS, shell: 'CMD.EXE'},
            isWindows,
          ),
        ).toEqual({command: 'CMD.EXE', args: [...CMD_FLAGS, SCRIPT]});
      },
    );

    it('runs powershell code through pwsh off Windows', () => {
      expect(
        resolveSpawnCommand(
          CodeExecutionLanguage.POWERSHELL,
          SCRIPT,
          COMMANDS,
          false,
        ),
      ).toEqual({command: 'pwsh', args: [...POWERSHELL_FLAGS, SCRIPT]});
    });

    it('runs powershell code through powershell on Windows', () => {
      expect(
        resolveSpawnCommand(
          CodeExecutionLanguage.POWERSHELL,
          SCRIPT,
          COMMANDS,
          true,
        ),
      ).toEqual({command: 'powershell', args: [...POWERSHELL_FLAGS, SCRIPT]});
    });

    it.each([false, true])(
      'runs windows_cmd code through cmd.exe when isWindows is %s',
      (isWindows) => {
        expect(
          resolveSpawnCommand(
            CodeExecutionLanguage.WINDOWS_CMD,
            SCRIPT,
            COMMANDS,
            isWindows,
          ),
        ).toEqual({command: 'cmd.exe', args: [...CMD_FLAGS, SCRIPT]});
      },
    );

    it.each([false, true])(
      'falls back to the node command for an unsupported language when isWindows is %s',
      (isWindows) => {
        expect(
          resolveSpawnCommand(
            CodeExecutionLanguage.UNSPECIFIED,
            SCRIPT,
            COMMANDS,
            isWindows,
          ),
        ).toEqual({command: 'node-command', args: [SCRIPT]});
      },
    );
  });

  describe('createTempScriptFile', () => {
    it('falls back to a .js script when the language has no extension', async () => {
      const {filePath, tempDir} = await createTempScriptFile(
        'console.log("fallback");',
        CodeExecutionLanguage.UNSPECIFIED,
        undefined,
        false,
      );

      try {
        expect(path.basename(filePath)).toBe('script.js');
        await expect(fs.readFile(filePath, 'utf8')).resolves.toBe(
          'console.log("fallback");',
        );
      } finally {
        await fs.rm(tempDir, {recursive: true, force: true});
      }
    });
  });
});
