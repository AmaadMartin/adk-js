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
 * How long a finished or timed-out execution's process group is given to exit
 * after `SIGTERM` before it is killed outright, so teardown cannot block
 * forever. Mirrors `_TERMINATE_GRACE_SECONDS` in adk-python.
 */
const TERMINATE_GRACE_MS = 5000;

/**
 * Whether an execution can be put in its own process group. Windows has no
 * process groups, and `detached` there means "own console, outlives the
 * parent", which is the opposite of what this is for.
 */
const USE_PROCESS_GROUP = !IS_WINDOWS;

/** The only signals this module sends to an execution's process group. */
type TerminationSignal = 'SIGTERM' | 'SIGKILL';

/** Signals every process left in `group`, tolerating a group already gone. */
function signalGroup(group: number, signal: TerminationSignal): void {
  try {
    process.kill(-group, signal);
  } catch {
    logger.debug(`Could not signal the execution process group ${group}.`);
  }
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
   */
  shellCommandPath?: string;
}

async function createTempScriptFile(
  code: string,
  language: CodeExecutionLanguage,
  shellCommandPath?: string,
): Promise<{filePath: string; tempDir: string}> {
  // mkdtemp names the directory itself and creates it exclusively at 0o700.
  const tempDir = await fs.mkdtemp(
    path.join(os.tmpdir(), 'adk_js_unsafe_code_executor_'),
  );

  const ext = getExtensionForLanguage(language, shellCommandPath) || '.js';
  const filePath = path.join(tempDir, `script${ext}`);
  await fs.writeFile(filePath, code);

  return {filePath, tempDir};
}

function getExtensionForLanguage(
  language: CodeExecutionLanguage,
  shellCommandPath?: string,
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
 * **Process Lifetime**:
 * - On POSIX the execution runs in its own process group. When the call
 *   finishes, by timeout or by normal completion, the executor sends `SIGTERM`
 *   to that whole group and then always `SIGKILL`. A background process the
 *   executed code started does not outlive the call, unless the code moved it
 *   out of the group with its own `setsid`.
 * - Because the execution leaves the agent's session, a `Ctrl-C` sent to the
 *   agent's terminal no longer reaches it, and killing the agent outright
 *   orphans the group instead of tearing it down.
 * - On Windows there are no process groups, so the executor terminates only the
 *   script process. Processes the code started can survive the call.
 *
 * WARNING: This executor runs code in the local environment without sandboxing or security restrictions.
 * Use with caution and only for trusted code.
 */
export class UnsafeLocalCodeExecutor extends BaseCodeExecutor {
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
        this.shellCommandPath,
      );
      const filePath = res.filePath;
      tempDir = res.tempDir;

      if (params.codeExecutionInput.inputFiles) {
        await materializeFiles(params.codeExecutionInput.inputFiles, tempDir);
      }

      let command = this.nodeCommandPath;
      let args = [filePath];

      if (language === CodeExecutionLanguage.PYTHON) {
        command = this.pythonCommandPath;
      } else if (language === CodeExecutionLanguage.SHELL) {
        command = this.shellCommandPath;
        if (this.shellCommandPath.toLowerCase().includes('powershell')) {
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
        });

        // `detached` makes the child lead a new group whose id is its pid. That
        // group, not the child alone, holds whatever the executed code spawned.
        const group = USE_PROCESS_GROUP ? child.pid : undefined;

        let stdout = '';
        let stderr = '';
        let timedOut = false;
        let settled = false;
        let exitedWith: number | null = null;
        let killTimer: ReturnType<typeof setTimeout> | undefined;

        const terminate = (signal: TerminationSignal) => {
          if (group === undefined) {
            child.kill(signal);
            return;
          }
          signalGroup(group, signal);
        };

        // Sends the `SIGKILL` that a started teardown owes the group, once and
        // only once. `close` arriving proves the pipe holders are gone, not
        // that a group member ignoring `SIGTERM` has exited, so the escalation
        // happens whether the grace period expired or the call settled first.
        const escalate = () => {
          if (killTimer === undefined) {
            return;
          }
          clearTimeout(killTimer);
          killTimer = undefined;
          terminate('SIGKILL');
        };

        const settle = (exitCode: number | null) => {
          if (settled) {
            return;
          }
          settled = true;
          clearTimeout(timeoutTimer);
          escalate();
          if (timedOut) {
            stderr += `\nCode execution timed out after ${this.timeoutSeconds} seconds.`;
          } else if (exitCode !== 0 && exitCode !== null && !stderr) {
            stderr = `Exit code ${exitCode}`;
          }
          resolve({stdout, stderr, exitCode});
        };

        // Runs on the normal path too, not only on timeout: once the script is
        // gone whatever it started is unwatched, and anything still holding the
        // stdio pipes keeps `close` from ever arriving.
        const tearDown = () => {
          if (settled || killTimer) {
            return;
          }
          terminate('SIGTERM');
          killTimer = setTimeout(() => {
            escalate();
            settle(exitedWith);
          }, TERMINATE_GRACE_MS);
        };

        const timeoutTimer = setTimeout(() => {
          timedOut = true;
          tearDown();
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

        // The exit code is recorded here because `close` may never arrive: the
        // escalation then settles the call and still reports it.
        child.on('exit', (code) => {
          exitedWith = code;
          tearDown();
        });

        child.on('close', (exitCode) => settle(exitCode));
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
