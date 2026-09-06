/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {ChildProcess, spawn} from 'node:child_process';
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
import {
  PYTHON_RUNNER_SOURCE,
  pythonChildEnv,
  pythonRunName,
} from './python_runner.js';

const IS_WINDOWS = os.platform() === 'win32';

/**
 * Whether the child leads its own process group, so that a timeout can reach
 * everything the executed code spawned. On Windows `detached` opens a new
 * console window instead, and there is no group to signal.
 */
const USE_PROCESS_GROUP = !IS_WINDOWS;

/**
 * How long a timed-out execution has to exit after `SIGTERM` before it is
 * killed outright.
 */
const TERMINATE_GRACE_MS = 5000;

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
 * Whether `commandPath` names Windows PowerShell (`powershell`) or PowerShell
 * 7+ (`pwsh`). `path.win32` splits on both separators on every platform.
 */
function isPowerShellCommand(commandPath: string): boolean {
  return /^(powershell|pwsh)(\.exe)?$/i.test(path.win32.basename(commandPath));
}

/**
 * Signals the whole execution: first the group that holds whatever the code
 * spawned, then the child itself, which is what platforms with no group have.
 */
function signalExecution(
  child: ChildProcess,
  signal: 'SIGTERM' | 'SIGKILL',
): void {
  if (USE_PROCESS_GROUP && child.pid !== undefined) {
    try {
      process.kill(-child.pid, signal);
    } catch (e: unknown) {
      // An already-empty group reports ESRCH, which is not an error here.
      logger.debug(`Could not signal the execution process group: ${e}`);
    }
  }
  child.kill(signal);
}

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
   *
   * When it names `powershell` or `pwsh` (with or without `.exe`) the script
   * is written as `.ps1` and run through PowerShell rather than as a bare
   * shell script.
   */
  shellCommandPath?: string;
  /**
   * Rejected when true: this executor cannot be stateful.
   */
  stateful?: boolean;
  /**
   * Rejected when true: this executor cannot optimize data files.
   */
  optimizeDataFile?: boolean;
}

async function createTempDir(): Promise<string> {
  // mkdtemp names the directory itself and creates it exclusively at 0o700.
  return fs.mkdtemp(path.join(os.tmpdir(), 'adk_js_unsafe_code_executor_'));
}

async function writeScriptFile(
  tempDir: string,
  code: string,
  language: CodeExecutionLanguage,
  shellCommandPath?: string,
): Promise<string> {
  const ext = getExtensionForLanguage(language, shellCommandPath) || '.js';
  const filePath = path.join(tempDir, `script${ext}`);
  await fs.writeFile(filePath, code);

  return filePath;
}

/**
 * The extension of the script file a language runs from. Python has none: its
 * program is written to the child's stdin instead.
 */
function getExtensionForLanguage(
  language: CodeExecutionLanguage,
  shellCommandPath?: string,
): string | undefined {
  if (language === CodeExecutionLanguage.JAVASCRIPT) {
    return '.js';
  }

  if (language === CodeExecutionLanguage.POWERSHELL) {
    return '.ps1';
  }

  if (language === CodeExecutionLanguage.WINDOWS_CMD) {
    return '.bat';
  }

  if (language === CodeExecutionLanguage.SHELL) {
    if (shellCommandPath && isPowerShellCommand(shellCommandPath)) {
      return '.ps1';
    }
    if (IS_WINDOWS) {
      if (shellCommandPath && shellCommandPath.toLowerCase().includes('cmd')) {
        return '.bat';
      }
      return '.ps1';
    }
    return '.sh';
  }

  return undefined;
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
 * Python code is passed to the interpreter on stdin and compiled under the
 * name `<code>`, so it has no `__file__` and reads stdin at end-of-file.
 *
 * On POSIX the child leads its own process group, so that a timeout reaches
 * everything the code spawned. It therefore no longer receives the parent
 * terminal's `SIGINT`.
 *
 * WARNING: This executor runs code in the local environment without sandboxing or security restrictions.
 * Use with caution and only for trusted code.
 */
export class UnsafeLocalCodeExecutor extends BaseCodeExecutor {
  override readonly stateful = false;
  override readonly optimizeDataFile = false;

  private readonly timeoutSeconds: number;
  private readonly nodeCommandPath: string;
  private readonly pythonCommandPath: string;
  private readonly shellCommandPath: string;

  constructor(options: UnsafeLocalCodeExecutorOptions = {}) {
    super();
    if (options.stateful) {
      throw new Error('Cannot set `stateful=true` in UnsafeLocalCodeExecutor.');
    }
    if (options.optimizeDataFile) {
      throw new Error(
        'Cannot set `optimizeDataFile=true` in UnsafeLocalCodeExecutor.',
      );
    }
    this.timeoutSeconds = options.timeoutSeconds ?? 30;
    this.nodeCommandPath = options.commandPath ?? process.execPath;
    this.pythonCommandPath =
      options.pythonCommandPath ?? (IS_WINDOWS ? 'python' : 'python3');
    this.shellCommandPath =
      options.shellCommandPath ?? (IS_WINDOWS ? 'powershell' : 'bash');
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

    const isPython = language === CodeExecutionLanguage.PYTHON;
    let tempDir: string | undefined;
    try {
      tempDir = await createTempDir();

      if (params.codeExecutionInput.inputFiles) {
        await materializeFiles(params.codeExecutionInput.inputFiles, tempDir);
      }

      let command = this.nodeCommandPath;
      let args: string[];
      let scriptFileName: string | undefined;

      if (isPython) {
        command = this.pythonCommandPath;
        args = ['-c', PYTHON_RUNNER_SOURCE, pythonRunName(code)];
      } else {
        const filePath = await writeScriptFile(
          tempDir,
          code,
          language,
          this.shellCommandPath,
        );
        scriptFileName = path.basename(filePath);
        args = [filePath];

        if (language === CodeExecutionLanguage.SHELL) {
          command = this.shellCommandPath;
          if (isPowerShellCommand(this.shellCommandPath)) {
            args = [...POWERSHELL_BASE_ARGS, filePath];
          } else if (this.shellCommandPath.toLowerCase().includes('cmd')) {
            args = [...CMD_BASE_ARGS, filePath];
          }
        } else if (language === CodeExecutionLanguage.POWERSHELL) {
          command = IS_WINDOWS ? 'powershell' : 'pwsh';
          args = [...POWERSHELL_BASE_ARGS, filePath];
        } else if (language === CodeExecutionLanguage.WINDOWS_CMD) {
          command = 'cmd.exe';
          args = [...CMD_BASE_ARGS, filePath];
        }
      }

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
          cwd: tempDir,
          detached: USE_PROCESS_GROUP,
          env: isPython ? pythonChildEnv() : undefined,
        });

        let stdout = '';
        let stderr = '';
        let timedOut = false;
        let escalationTimer: ReturnType<typeof setTimeout> | undefined;

        // `spawn`'s own `timeout` option kills the interpreter and then leaves
        // us waiting on 'close', which only fires once every stdio stream is
        // closed. An interpreter that forked rather than exec'd leaves a
        // survivor holding those pipes, so 'close' never arrives and this
        // promise never settles -- no timeout value bounds that wait. Run the
        // timer here instead and release the read ends along with the kill, so
        // the timeout is actually enforced. Mirrors LocalEnvironment.execute.
        const timer = setTimeout(() => {
          timedOut = true;
          // SIGTERM first, so the code and everything it spawned get the same
          // grace period before anything is killed outright.
          signalExecution(child, 'SIGTERM');
          escalationTimer = setTimeout(() => {
            signalExecution(child, 'SIGKILL');
            child.stdout?.destroy();
            child.stderr?.destroy();
          }, TERMINATE_GRACE_MS);
        }, this.timeoutSeconds * 1000);

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

        if (isPython) {
          child.stdin?.on('error', (err) => {
            // A child that died before reading reports EPIPE, which would
            // otherwise surface as an unhandled stream error.
            logger.debug(`Could not write the program to python: ${err}`);
          });
          child.stdin?.write(code);
          child.stdin?.end();
        }

        child.on('close', (exitCode, signal) => {
          clearTimeout(timer);
          // Signalling a group id the OS may have recycled is what an armed
          // escalation timer would do once the child is reaped.
          clearTimeout(escalationTimer);
          // Node reports either an exit code or the terminating signal; Python
          // reports the negative signal number (`-9` for SIGKILL), so map back.
          const exitStatus =
            signal === null ? exitCode : -os.constants.signals[signal];

          if (timedOut) {
            // Whatever the code wrote before it was killed is still the useful
            // diagnostic, but on its own it would hide the cut-short run.
            const note = `Code execution timed out after ${this.timeoutSeconds} seconds.`;
            stderr = stderr ? `${stderr}\n${note}` : note;
          } else if (!stderr && exitStatus !== null && exitStatus !== 0) {
            // The code died without saying why: a signal, or `os._exit`.
            stderr = `Code execution exited with status ${exitStatus}.`;
          }
          resolve({stdout, stderr, exitCode: exitStatus});
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
          if (relativeFilePath === scriptFileName) {
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
        exitCode: executionResult.exitCode,
      };
    } finally {
      if (tempDir) {
        await fs.rm(tempDir, {recursive: true, force: true});
      }
    }
  }
}
