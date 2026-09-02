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
 * Whether a timed-out execution can be signalled as a process group. On
 * Windows `detached` opens a new console window instead of starting a group,
 * so there is nothing to signal there.
 */
const USE_PROCESS_GROUP = !IS_WINDOWS;

/**
 * How long a timed-out execution has to exit after SIGTERM before the executor
 * escalates to SIGKILL, so that the timeout itself cannot block forever.
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
 * Signals a timed-out execution, and the process group it leads where there is
 * one, so that whatever the code spawned goes with it.
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
}

function createTempDir(): Promise<string> {
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
 * - **Python**: Executed via `python3` on Unix, and `python` on Windows. The
 *   program arrives on the child's stdin and is compiled as `<code>`, so it has
 *   no `__file__` and its tracebacks name `<code>` rather than a temporary
 *   path.
 * - **Shell**: Executed via `bash` on Unix, and defaults to `powershell` (injecting `-NoProfile` and `-ExecutionPolicy Bypass`) or `cmd.exe` (injecting `/D`) on Windows.
 *
 * On POSIX the child leads its own process group, so a timeout takes down
 * everything the code spawned. The child no longer receives the parent
 * terminal's `SIGINT` as a consequence.
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

      let command = this.pythonCommandPath;
      let args = ['-c', PYTHON_RUNNER_SOURCE, pythonRunName(code)];
      // Only Python gets an explicit environment; every other language keeps
      // inheriting the parent's.
      let env: typeof process.env | undefined = pythonChildEnv();
      let scriptFileName: string | undefined;

      if (!isPython) {
        const filePath = await writeScriptFile(
          tempDir,
          code,
          language,
          this.shellCommandPath,
        );
        scriptFileName = path.basename(filePath);
        command = this.nodeCommandPath;
        args = [filePath];
        env = undefined;

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

      if (params.codeExecutionInput.inputFiles) {
        await materializeFiles(params.codeExecutionInput.inputFiles, tempDir);
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
      }>((resolve) => {
        const child = spawn(command, args, {
          cwd: tempDir,
          env,
          detached: USE_PROCESS_GROUP,
        });

        let stdout = '';
        let stderr = '';
        let timedOut = false;
        let escalation: ReturnType<typeof setTimeout> | undefined;

        // `spawn`'s own `timeout` option kills the interpreter and then leaves
        // us waiting on 'close', which only fires once every stdio stream is
        // closed. An interpreter that forked rather than exec'd leaves a
        // survivor holding those pipes, so 'close' never arrives and this
        // promise never settles -- no timeout value bounds that wait. Run the
        // timer here instead: SIGTERM the whole group, then escalate to
        // SIGKILL and release the read ends, so the timeout is actually
        // enforced.
        const timer = setTimeout(() => {
          timedOut = true;
          signalExecution(child, 'SIGTERM');
          escalation = setTimeout(() => {
            signalExecution(child, 'SIGKILL');
            child.stdout?.destroy();
            child.stderr?.destroy();
          }, TERMINATE_GRACE_MS);
        }, this.timeoutSeconds * 1000);

        if (isPython) {
          // A child that dies before reading the program reports EPIPE, which
          // would otherwise surface as an unhandled stream error.
          child.stdin?.on('error', (e: Error) => {
            logger.debug(`Could not send the program to the child: ${e}`);
          });
          child.stdin?.write(code);
        }
        // Closed on every path, so a program that reads stdin sees
        // end-of-file instead of blocking until the timeout.
        child.stdin?.end();

        if (child.stdout) {
          // Decode as the chunks arrive, so a multi-byte character split
          // across a chunk boundary is not corrupted.
          child.stdout.setEncoding('utf-8');
          child.stdout.on('data', (data: string) => {
            stdout += data;
          });
        }

        if (child.stderr) {
          child.stderr.setEncoding('utf-8');
          child.stderr.on('data', (data: string) => {
            stderr += data;
          });
        }

        child.on('error', (err) => {
          stderr += `Process error: ${err.message}\n`;
        });

        child.on('close', (exitCode, signal) => {
          clearTimeout(timer);
          // Once the child is reaped its pid can be recycled, and an armed
          // escalation would then signal an unrelated group.
          clearTimeout(escalation);

          // Node reports either an exit code or the terminating signal;
          // Python reports the negative signal number, so map back.
          const exitStatus =
            signal === null ? exitCode : -os.constants.signals[signal];

          if (timedOut) {
            // Whatever the code wrote before it was killed is still the useful
            // diagnostic, but on its own it would hide the fact that the run
            // was cut short.
            const note = `Code execution timed out after ${this.timeoutSeconds} seconds.`;
            stderr = stderr ? `${stderr}\n${note}` : note;
          } else if (exitCode === 0) {
            // A non-empty stderr is what marks the result failed and drives
            // the retry counter, so it has to mean the program failed rather
            // than that the program wrote a warning. The exit status says
            // which happened, and a failed spawn reports a negative errno
            // here, so the 'error' handler's text survives.
            stderr = '';
          } else if (!stderr && exitStatus !== null) {
            // The code died without saying why: a signal, or a call to
            // `os._exit`. Reporting nothing would show the model a clean run.
            stderr = `Code execution exited with status ${exitStatus}.`;
          }
          resolve({stdout, stderr});
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

          // Skip the script file, when there is one: Python arrives on stdin.
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
      };
    } finally {
      if (tempDir) {
        await fs.rm(tempDir, {recursive: true, force: true});
      }
    }
  }
}
