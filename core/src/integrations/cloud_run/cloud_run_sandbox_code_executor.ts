/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {spawn} from 'node:child_process';
import * as os from 'node:os';
import {
  BaseCodeExecutor,
  ExecuteCodeParams,
} from '../../code_executors/base_code_executor.js';
import {CodeExecutionResult} from '../../code_executors/code_execution_utils.js';
import {formatError} from '../../utils/error_utils.js';
import {logger} from '../../utils/logger.js';

/** Path of the guest sandbox binary installed by the Cloud Run runtime. */
const DEFAULT_SANDBOX_BIN = '/usr/local/gcp/bin/sandbox';

/** Wall-clock bound in seconds applied when the caller names none. */
const DEFAULT_TIMEOUT_SECONDS = 300;

/**
 * The status a timed-out run reports. The child is killed with `SIGKILL`, and
 * Node reports a signal-killed child as `code === null`, so the negative signal
 * number POSIX callers expect has to be computed here. Windows has no signals
 * and reports `TerminateProcess`'s 1 instead.
 */
const TIMEOUT_EXIT_CODE =
  process.platform === 'win32' ? 1 : -os.constants.signals.SIGKILL;

/**
 * stderr fragments the sandbox writes while it tears down its network
 * namespace. They appear on runs that fully succeed, and any non-empty stderr
 * makes the code execution result report `OUTCOME_FAILED` to the model, so an
 * unfiltered healthy run looks like a failure.
 */
const HARMLESS_STDERR_FRAGMENTS = [
  'Failed to cleanup network namespace',
  'failed to unmount netns file',
];

/** Removes the sandbox teardown warnings from `stderr`. */
function filterStderr(stderr: string): string {
  const lines = stderr.split(/\r?\n/);
  // Python's `splitlines()` produces no trailing empty element. Match it so
  // filtered and unfiltered stderr come back with the same shape.
  if (lines.at(-1) === '') {
    lines.pop();
  }
  return lines
    .filter((line) => !HARMLESS_STDERR_FRAGMENTS.some((f) => line.includes(f)))
    .join('\n');
}

/** Whether `err` reports a spawn that failed because the binary is missing. */
function isFileNotFoundError(err: Error): boolean {
  return 'code' in err && err.code === 'ENOENT';
}

/** The status a finished child exited with, as a POSIX shell reports it. */
function exitStatus(
  code: number | null,
  signal: NodeJS.Signals | null,
): number | null {
  return signal === null ? code : -os.constants.signals[signal];
}

/** Options for {@link CloudRunSandboxCodeExecutor}. */
export interface CloudRunSandboxCodeExecutorOptions {
  /** Path of the guest sandbox binary. Default `/usr/local/gcp/bin/sandbox`. */
  sandboxBin?: string;
  /** Whether the sandbox may reach the network. Default `false`. */
  allowEgress?: boolean;
  /**
   * Absolute path of the interpreter invoked inside the sandbox, which reads
   * the program from stdin. Default `process.execPath`.
   */
  interpreterPath?: string;
  /**
   * Wall-clock bound in seconds on one execution. Defaults to 300. Pass `null`
   * to wait indefinitely.
   */
  timeoutSeconds?: number | null;
  /** Unsupported; constructing with `true` throws. */
  stateful?: boolean;
  /** Unsupported; constructing with `true` throws. */
  optimizeDataFile?: boolean;
}

/**
 * Executes code inside a Cloud Run sandbox through the guest `sandbox` CLI.
 *
 * The executor runs from inside a Cloud Run container that has sandboxes
 * enabled. It cannot reach a sandbox remotely, because it drives the local
 * guest binary the Cloud Run container runtime installs. Anywhere else the
 * binary is missing and every call returns a result whose `stderr` says so.
 *
 * One call spawns `sandbox do [--allow-egress] <interpreterPath>` and writes
 * the code to the child's stdin. `codeExecutionInput.language` is ignored:
 * `interpreterPath` is the knob that chooses the runtime, matching the
 * reference implementation, which always runs one interpreter.
 *
 * `executeCode` never throws. A missing binary, a spawn failure and a timeout
 * all come back as a {@link CodeExecutionResult}.
 */
export class CloudRunSandboxCodeExecutor extends BaseCodeExecutor {
  override readonly stateful = false;
  override readonly optimizeDataFile = false;
  /** Path of the guest sandbox binary. */
  readonly sandboxBin: string;
  /** Whether the sandbox may reach the network. */
  readonly allowEgress: boolean;
  /** Interpreter the sandbox runs, which reads the program from stdin. */
  readonly interpreterPath: string;
  /** Wall-clock bound in seconds, or `undefined` to wait indefinitely. */
  readonly timeoutSeconds?: number;

  constructor(options: CloudRunSandboxCodeExecutorOptions = {}) {
    super();
    if (options.stateful) {
      throw new Error(
        'Cannot set `stateful: true` in CloudRunSandboxCodeExecutor.',
      );
    }
    if (options.optimizeDataFile) {
      throw new Error(
        'Cannot set `optimizeDataFile: true` in CloudRunSandboxCodeExecutor.',
      );
    }
    this.sandboxBin = options.sandboxBin ?? DEFAULT_SANDBOX_BIN;
    this.allowEgress = options.allowEgress ?? false;
    this.interpreterPath = options.interpreterPath ?? process.execPath;
    this.timeoutSeconds =
      options.timeoutSeconds === null
        ? undefined
        : (options.timeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS);
  }

  async executeCode(params: ExecuteCodeParams): Promise<CodeExecutionResult> {
    const {code} = params.codeExecutionInput;
    logger.debug(
      `Executing code in Cloud Run Sandbox:\n\`\`\`\n${code}\n\`\`\``,
    );

    const args = ['do'];
    if (this.allowEgress) {
      args.push('--allow-egress');
    }
    args.push(this.interpreterPath);
    logger.debug(
      `Running sandbox command: ${[this.sandboxBin, ...args].join(' ')}`,
    );

    return new Promise<CodeExecutionResult>((resolve) => {
      const child = spawn(this.sandboxBin, args);
      let stdout = '';
      let stderr = '';
      let timedOut = false;
      let timer: ReturnType<typeof setTimeout> | undefined;

      // 'error' and 'close' can both fire. `resolve` and `clearTimeout` are
      // both idempotent, so the second call is a no-op.
      const settle = (result: CodeExecutionResult) => {
        clearTimeout(timer);
        resolve(result);
      };

      // `spawn`'s own `timeout` kills the child and then leaves us waiting on
      // 'close', which only fires once every stdio pipe is closed. `sandbox`
      // supervises the interpreter rather than exec'ing into it, so a survivor
      // can hold the inherited pipes and 'close' never arrives. Run the timer
      // here and release the read ends along with the kill, as
      // `UnsafeLocalCodeExecutor` does.
      if (this.timeoutSeconds !== undefined) {
        timer = setTimeout(() => {
          timedOut = true;
          child.kill('SIGKILL');
          child.stdout.destroy();
          child.stderr.destroy();
        }, this.timeoutSeconds * 1000);
      }

      child.stdout.setEncoding('utf-8');
      child.stdout.on('data', (chunk: string) => {
        stdout += chunk;
      });
      child.stderr.setEncoding('utf-8');
      child.stderr.on('data', (chunk: string) => {
        stderr += chunk;
      });

      // An interpreter that exits before draining stdin raises EPIPE, and an
      // unhandled stream 'error' terminates the host process.
      child.stdin.on('error', (err: Error) => {
        logger.debug(`Sandbox stdin closed early: ${formatError(err)}`);
      });
      child.stdin.end(code);

      child.on('error', (err: Error) => {
        if (isFileNotFoundError(err)) {
          logger.error(`Sandbox binary not found: ${formatError(err)}`);
          settle({
            stdout: '',
            stderr:
              `Sandbox binary "${this.sandboxBin}" not found. Ensure you are` +
              ' running in an environment with the sandbox tool installed.',
            outputFiles: [],
          });
          return;
        }
        logger.error(`Unexpected error running sandbox: ${formatError(err)}`);
        settle({
          stdout: '',
          stderr: `Unexpected error running sandbox: ${formatError(err)}`,
          outputFiles: [],
        });
      });

      child.on('close', (exitCode, signal) => {
        const filtered = filterStderr(stderr);
        if (timedOut) {
          logger.error(
            `Sandbox execution timed out after ${this.timeoutSeconds} seconds.`,
          );
          settle({
            stdout,
            stderr:
              filtered ||
              `Code execution timed out after ${this.timeoutSeconds} seconds.`,
            outputFiles: [],
            exitCode: TIMEOUT_EXIT_CODE,
          });
          return;
        }
        if (stderr) {
          logger.warn(`Sandbox stderr: ${stderr}`);
        }
        logger.debug(
          `Sandbox execution finished. Exit code: ${exitCode}, stdout length:` +
            ` ${stdout.length}, stderr length: ${stderr.length}`,
        );
        settle({
          stdout,
          stderr: filtered,
          outputFiles: [],
          exitCode: exitStatus(exitCode, signal),
        });
      });
    });
  }
}
