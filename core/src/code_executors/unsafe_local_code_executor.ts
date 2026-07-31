/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {spawn} from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {getMimeTypeAndEncoding} from '../utils/file_extension_utils.js';
import {materializeFiles} from '../utils/file_utils.js';
import {logger} from '../utils/logger.js';
import {BaseCodeExecutor, ExecuteCodeParams} from './base_code_executor.js';
import {
  CodeExecutionLanguage,
  CodeExecutionResult,
  File,
} from './code_execution_utils.js';

const IS_WINDOWS = os.platform() === 'win32';

/**
 * Prepended to every PowerShell invocation; `-NoProfile` keeps ambient profile
 * state (PATH, aliases, preference variables, stray output) out of the script.
 */
const POWERSHELL_BASE_ARGS = [
  '-NoLogo',
  '-NoProfile',
  '-ExecutionPolicy',
  'Bypass',
  '-File',
] as const;

/**
 * Prepended to every cmd.exe invocation; `/D` skips the registry AutoRun
 * commands, the `-NoProfile` analogue.
 */
const CMD_BASE_ARGS = ['/D', '/c'] as const;

/**
 * Options for UnsafeLocalCodeExecutor.
 */
export interface UnsafeLocalCodeExecutorOptions {
  /**
   * Timeout for code execution in seconds. Default is 30.
   */
  timeoutSeconds?: number;
  /**
   * The command to run JavaScript code. Default is `process.execPath` (Node.js).
   */
  commandPath?: string;
  /**
   * The command to run Python code. Default is `python3`.
   */
  pythonCommandPath?: string;
  /**
   * The command to run Shell code. Default is `bash`.
   */
  shellCommandPath?: string;
}

/**
 * The interpreter commands an executor runs scripts with, resolved once from
 * the caller's options and the host platform.
 */
export interface InterpreterCommands {
  node: string;
  python: string;
  shell: string;
}

export async function createTempScriptFile(
  code: string,
  language: CodeExecutionLanguage,
  shellCommandPath: string | undefined,
  isWindows: boolean,
): Promise<{filePath: string; tempDir: string}> {
  const tempDir = path.join(
    os.tmpdir(),
    'adk_js_unsafe_code_executor',
    Date.now().toString() + '_' + Math.random().toString(36).slice(2),
  );
  await fs.mkdir(tempDir, {recursive: true});

  const ext =
    getExtensionForLanguage(language, shellCommandPath, isWindows) || '.js';
  const filePath = path.join(tempDir, `script${ext}`);
  await fs.writeFile(filePath, code);

  return {filePath, tempDir};
}

/**
 * `isWindows` is required rather than defaulted to `IS_WINDOWS` so that both
 * arms stay reachable from a test on any host. A default would itself be a
 * branch only one platform can ever take.
 */
export function getExtensionForLanguage(
  language: CodeExecutionLanguage,
  shellCommandPath: string | undefined,
  isWindows: boolean,
): string | undefined {
  if (language === CodeExecutionLanguage.JAVASCRIPT) {
    return '.js';
  }

  if (language === CodeExecutionLanguage.PYTHON) {
    return '.py';
  }

  if (language === CodeExecutionLanguage.POWERSHELL) {
    return '.ps1';
  }

  if (language === CodeExecutionLanguage.WINDOWS_CMD) {
    return '.bat';
  }

  if (language === CodeExecutionLanguage.SHELL) {
    if (isWindows) {
      if (shellCommandPath && shellCommandPath.toLowerCase().includes('cmd')) {
        return '.bat';
      }
      return '.ps1';
    }
    return '.sh';
  }

  return undefined;
}

/** Applies the platform's interpreter defaults to the caller's options. */
export function resolveInterpreterDefaults(
  options: UnsafeLocalCodeExecutorOptions,
  isWindows: boolean,
): InterpreterCommands {
  return {
    node: options.commandPath ?? process.execPath,
    python: options.pythonCommandPath ?? (isWindows ? 'python' : 'python3'),
    shell: options.shellCommandPath ?? (isWindows ? 'powershell' : 'bash'),
  };
}

/**
 * Picks the interpreter and its flags for `language`. An unrecognised language
 * falls through to the node command with no extra flags; `executeCode` rejects
 * those before ever reaching here.
 */
export function resolveSpawnCommand(
  language: CodeExecutionLanguage,
  filePath: string,
  commands: InterpreterCommands,
  isWindows: boolean,
): {command: string; args: string[]} {
  if (language === CodeExecutionLanguage.PYTHON) {
    return {command: commands.python, args: [filePath]};
  }

  if (language === CodeExecutionLanguage.SHELL) {
    const shell = commands.shell.toLowerCase();
    if (shell.includes('powershell')) {
      return {
        command: commands.shell,
        args: [...POWERSHELL_BASE_ARGS, filePath],
      };
    }
    if (shell.includes('cmd')) {
      return {command: commands.shell, args: [...CMD_BASE_ARGS, filePath]};
    }
    return {command: commands.shell, args: [filePath]};
  }

  if (language === CodeExecutionLanguage.POWERSHELL) {
    return {
      command: isWindows ? 'powershell' : 'pwsh',
      args: [...POWERSHELL_BASE_ARGS, filePath],
    };
  }

  if (language === CodeExecutionLanguage.WINDOWS_CMD) {
    return {command: 'cmd.exe', args: [...CMD_BASE_ARGS, filePath]};
  }

  return {command: commands.node, args: [filePath]};
}

/**
 * A code executor that unsafely executes code in the local context.
 * Supports JavaScript, Python, and Shell capabilities cross-platform.
 *
 * **Execution Details**:
 * - **JavaScript**: Executed via `node` (defaults to `process.execPath`).
 * - **Python**: Executed via `python3` on Unix, and `python` on Windows.
 * - **Shell**: Executed via `bash` on Unix, and defaults to `powershell` (injecting `-NoProfile` and `-ExecutionPolicy Bypass`) or `cmd.exe` (injecting `/D`) on Windows.
 *
 * WARNING: This executor runs code in the local environment without sandboxing or security restrictions.
 * Use with caution and only for trusted code.
 */
export class UnsafeLocalCodeExecutor extends BaseCodeExecutor {
  private readonly timeoutSeconds: number;
  private readonly commands: InterpreterCommands;

  constructor(options: UnsafeLocalCodeExecutorOptions = {}) {
    super();
    this.timeoutSeconds = options.timeoutSeconds ?? 30;
    this.commands = resolveInterpreterDefaults(options, IS_WINDOWS);
    this.stateful = false;
    this.optimizeDataFile = false;
  }

  async executeCode(params: ExecuteCodeParams): Promise<CodeExecutionResult> {
    const {code, language} = params.codeExecutionInput;
    if (
      ![
        CodeExecutionLanguage.JAVASCRIPT,
        CodeExecutionLanguage.PYTHON,
        CodeExecutionLanguage.SHELL,
        CodeExecutionLanguage.WINDOWS_CMD,
        CodeExecutionLanguage.POWERSHELL,
      ].includes(language)
    ) {
      return {
        stdout: '',
        stderr: `Unsupported language: ${language}`,
        outputFiles: [],
      };
    }

    logger.warn(
      '\n====================================================================================\n' +
        '⚠️ DANGER: UnsafeLocalCodeExecutor is executing code locally on this host machine!\n' +
        'This component provides NO sandboxing or container isolation. Arbitrary shell/script\n' +
        'commands generated by AI or untrusted sources could lead to serious security risks.\n' +
        '====================================================================================\n',
    );

    let tempDir: string | undefined;
    try {
      const res = await createTempScriptFile(
        code,
        language,
        this.commands.shell,
        IS_WINDOWS,
      );
      const filePath = res.filePath;
      tempDir = res.tempDir;

      if (params.codeExecutionInput.inputFiles) {
        await materializeFiles(params.codeExecutionInput.inputFiles, tempDir);
      }

      const {command, args} = resolveSpawnCommand(
        language,
        filePath,
        this.commands,
        IS_WINDOWS,
      );

      if (params.codeExecutionInput.args) {
        if (Array.isArray(params.codeExecutionInput.args)) {
          args.push(...params.codeExecutionInput.args);
        } else {
          for (const [k, v] of Object.entries(params.codeExecutionInput.args)) {
            args.push(`--${k}`, String(v));
          }
        }
      }

      const executionResult = await new Promise<{
        stdout: string;
        stderr: string;
        exitCode: number | null;
      }>((resolve) => {
        const child = spawn(command, args, {
          timeout: this.timeoutSeconds * 1000,
          killSignal: 'SIGKILL',
          cwd: tempDir,
        });

        let stdout = '';
        let stderr = '';

        if (child.stdout) {
          child.stdout.on('data', (data) => {
            stdout += data.toString();
          });
        }

        if (child.stderr) {
          child.stderr.on('data', (data) => {
            stderr += data.toString();
          });
        }

        child.on('error', (err) => {
          stderr += `Process error: ${err.message}\n`;
        });

        child.on('close', (exitCode, signal) => {
          if (signal === 'SIGKILL' || signal === 'SIGTERM') {
            stderr += `\nCode execution timed out after ${this.timeoutSeconds} seconds.`;
          } else if (exitCode !== 0 && exitCode !== null) {
            if (!stderr) {
              stderr = `Exit code ${exitCode}`;
            }
          }
          resolve({stdout, stderr, exitCode});
        });
      });

      const outputFiles: File[] = [];
      try {
        const allFiles = await fs.readdir(tempDir, {recursive: true});
        for (const relativeFilePath of allFiles) {
          const fullPath = path.join(tempDir, relativeFilePath);
          const stat = await fs.lstat(fullPath);

          if (!stat.isFile()) {
            continue;
          }

          // Skip the script file
          if (relativeFilePath === path.basename(filePath)) {
            continue;
          }

          // Skip input files
          const isInputFile = params.codeExecutionInput.inputFiles?.some(
            (f) => f.name === relativeFilePath,
          );
          if (isInputFile) {
            continue;
          }

          const fileContent = await fs.readFile(fullPath);
          const {mimeType, encoding} = getMimeTypeAndEncoding(
            path.extname(relativeFilePath),
          );
          outputFiles.push({
            name: relativeFilePath,
            content: fileContent.toString(encoding),
            contentEncoding: encoding,
            mimeType: mimeType,
          });
        }
      } catch (e) {
        logger.error(`Error scanning output files: ${e}`);
      }

      return {
        stdout: executionResult.stdout,
        stderr: executionResult.stderr,
        outputFiles,
      };
    } finally {
      if (tempDir) {
        await fs.rm(tempDir, {recursive: true, force: true});
      }
    }
  }
}
