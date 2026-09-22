/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {spawn} from 'node:child_process';
import {formatError} from '../utils/error_utils.js';
import {logger} from '../utils/logger.js';
import {BaseCodeExecutor, ExecuteCodeParams} from './base_code_executor.js';
import {CodeExecutionResult} from './code_execution_utils.js';

/** Path of the guest sandbox binary supplied by the Cloud Run runtime. */
const DEFAULT_SANDBOX_BIN = '/usr/local/gcp/bin/sandbox';

/**
 * How long a killed child's stdio may keep draining before the run is reported
 * without it.
 *
 * When nothing outlives the child, `'close'` follows `'exit'` immediately
 * (measured at 0 ms even for a 50 MB stdout), so this budget only ever applies
 * to the timed-out run described on {@link CloudRunSandboxCodeExecutor}.
 */
const STDIO_DRAIN_GRACE_MS = 200;

/**
 * stderr fragments the sandbox emits while it tears down its network
 * namespace. They appear on fully successful runs, and any non-empty stderr
 * makes `buildCodeExecutionResultPart` report the execution to the model as
 * `OUTCOME_FAILED`, so a healthy run would otherwise look like a failure.
 */
const HARMLESS_STDERR_FRAGMENTS = [
  'Failed to cleanup network namespace',
  'failed to unmount netns file',
];

/** Removes the sandbox teardown warnings from `stderr`. */
function filterStderr(stderr: string): string {
  const lines = stderr.split(/\r?\n/);
  // Python's `splitlines()` drops the trailing newline. Match it so filtered
  // and unfiltered stderr come back shaped the same way.
  if (lines.at(-1) === '') {
    lines.pop();
  }
  return lines
    .filter((line) => !HARMLESS_STDERR_FRAGMENTS.some((f) => line.includes(f)))
    .join('\n');
}

/** True when `err` reports a spawn failure caused by a missing executable. */
function isFileNotFoundError(err: Error): boolean {
  return 'code' in err && err.code === 'ENOENT';
}

/** A result that carries a failure message and no output. */
function errorResult(stderr: string): CodeExecutionResult {
  return {stdout: '', stderr, outputFiles: []};
}

/** Options for {@link CloudRunSandboxCodeExecutor}. */
export interface CloudRunSandboxCodeExecutorOptions {
  /** Path of the guest sandbox binary. Default `/usr/local/gcp/bin/sandbox`. */
  sandboxBin?: string;

  /** Whether the sandbox may reach the network. Default `false`. */
  allowEgress?: boolean;

  /**
   * Absolute path of the interpreter invoked inside the sandbox, which reads
   * the program from stdin. Default `process.execPath`, the Node.js binary
   * running this process.
   */
  interpreterPath?: string;

  /**
   * Timeout in seconds for one execution. Unset means no timeout.
   */
  timeoutSeconds?: number;

  /** Unsupported. Constructing with `true` throws. */
  stateful?: boolean;

  /** Unsupported. Constructing with `true` throws. */
  optimizeDataFile?: boolean;
}

/**
 * Executes model-generated code inside a Cloud Run sandbox through the guest
 * `sandbox` CLI.
 *
 * This executor runs from inside a Cloud Run container that has sandboxes
 * enabled. It cannot execute code remotely from a local machine or from any
 * other external environment, because it invokes the local guest `sandbox`
 * binary that the Cloud Run container runtime provides. Anywhere else, every
 * call returns a "sandbox binary not found" result rather than throwing.
 *
 * The code is piped over stdin to an interpreter running inside the sandbox:
 * `sandbox do <interpreterPath>`. The executor ignores
 * `codeExecutionInput.language`, so set `interpreterPath` to match the language
 * the agent emits, for example `/usr/bin/python3`.
 */
export class CloudRunSandboxCodeExecutor extends BaseCodeExecutor {
  private readonly sandboxBin: string;
  private readonly allowEgress: boolean;
  private readonly interpreterPath: string;
  private readonly timeoutSeconds?: number;

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
    this.timeoutSeconds = options.timeoutSeconds;
    this.stateful = false;
    this.optimizeDataFile = false;
  }

  override async executeCode(
    params: ExecuteCodeParams,
  ): Promise<CodeExecutionResult> {
    const {code} = params.codeExecutionInput;
    const args = ['do'];
    if (this.allowEgress) {
      args.push('--allow-egress');
    }
    args.push(this.interpreterPath);

    logger.debug(
      `Executing code in Cloud Run sandbox:\n\`\`\`\n${code}\n\`\`\``,
    );
    logger.debug(
      `Running sandbox command: ${[this.sandboxBin, ...args].join(' ')}`,
    );

    try {
      return await new Promise<CodeExecutionResult>((resolve) => {
        const child = spawn(this.sandboxBin, args, {
          timeout:
            this.timeoutSeconds === undefined
              ? undefined
              : this.timeoutSeconds * 1000,
          killSignal: 'SIGKILL',
        });

        let stdout = '';
        let stderr = '';
        let drainTimer: ReturnType<typeof setTimeout> | undefined;
        let settled = false;

        // Lets go of the pipes, so an abandoned program stops growing the
        // accumulators, and reports the run. Every step is idempotent, so the
        // loser of a race costs nothing.
        const settle = (result: CodeExecutionResult) => {
          settled = true;
          clearTimeout(drainTimer);
          child.stdout.destroy();
          child.stderr.destroy();
          resolve(result);
        };

        // Both `'close'` and the drain timer below report a finished child,
        // and the loser of that race still fires. Log and report once.
        const report = (exitCode: number | null, signal: string | null) => {
          if (settled) {
            return;
          }
          if (stderr) {
            logger.warn(`Sandbox stderr: ${stderr}`);
          }
          const filtered = filterStderr(stderr);
          if (this.timeoutSeconds !== undefined && signal === 'SIGKILL') {
            logger.error(
              `Sandbox execution timed out after ${this.timeoutSeconds} seconds.`,
            );
            settle({
              stdout,
              stderr:
                filtered ||
                `Code execution timed out after ${this.timeoutSeconds} seconds.`,
              outputFiles: [],
            });
            return;
          }
          logger.debug(
            `Sandbox execution finished. Exit code: ${exitCode}, stdout length: ${stdout.length}, stderr length: ${stderr.length}`,
          );
          settle({stdout, stderr: filtered, outputFiles: []});
        };

        child.stdout.setEncoding('utf8');
        child.stdout.on('data', (chunk: string) => {
          stdout += chunk;
        });
        child.stderr.setEncoding('utf8');
        child.stderr.on('data', (chunk: string) => {
          stderr += chunk;
        });

        // An interpreter that exits before it drains stdin raises EPIPE here,
        // and an unhandled stream 'error' terminates the process. The child
        // still reports its own result, so surface that instead.
        child.stdin.on('error', (err) => {
          logger.debug(`Sandbox stdin closed early: ${formatError(err)}`);
        });

        child.on('error', (err) => {
          if (isFileNotFoundError(err)) {
            logger.error(`Sandbox binary not found: ${formatError(err)}`);
            settle(
              errorResult(
                `Sandbox binary "${this.sandboxBin}" not found. Ensure you are ` +
                  'running in an environment with the sandbox tool installed.',
              ),
            );
            return;
          }
          logger.error(`Unexpected error running sandbox: ${formatError(err)}`);
          settle(
            errorResult(
              `Unexpected error running sandbox: ${formatError(err)}`,
            ),
          );
        });

        child.on('close', report);

        child.on('exit', (exitCode, signal) => {
          if (this.timeoutSeconds === undefined || signal !== 'SIGKILL') {
            return;
          }
          // The timeout kills the `sandbox` process alone. Because `sandbox`
          // supervises the interpreter rather than replacing itself with it,
          // the interpreter survives holding the inherited pipes, and `'close'`
          // waits for every pipe. Waiting for `'close'` here would therefore
          // ignore `timeoutSeconds` for as long as the program runs.
          drainTimer = setTimeout(
            () => report(exitCode, signal),
            STDIO_DRAIN_GRACE_MS,
          );
        });

        child.stdin.end(code);
      });
    } catch (e: unknown) {
      logger.error(`Unexpected error running sandbox: ${formatError(e)}`);
      return errorResult(`Unexpected error running sandbox: ${formatError(e)}`);
    }
  }
}
