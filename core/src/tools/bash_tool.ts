/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {FunctionDeclaration, Type} from '@google/genai';
import {spawn} from 'child_process';
import {BaseTool, RunAsyncToolRequest} from './base_tool.js';

/**
 * Error returned when the tool is invoked on a non-POSIX host. Such hosts lack
 * `/bin/bash` and the `ulimit` builtin, so the tool cannot run. The message is
 * kept verbatim in sync with the adk-python reference implementation.
 */
export const UNSUPPORTED_PLATFORM_ERROR =
  'ExecuteBashTool is only supported on POSIX systems.';

/** Bytes per KiB. `ulimit -v` and `-f` take limits in 1024-byte (KiB) units. */
const BYTES_PER_KIB = 1024;

export interface BashToolPolicy {
  allowedCommandPrefixes?: string[];
  blockedOperators?: string[];
  timeoutSeconds?: number;
  /**
   * Virtual-memory cap in bytes, enforced best-effort on POSIX hosts via
   * `ulimit -v` (parity with adk-python's `RLIMIT_AS`). Ignored elsewhere.
   */
  maxMemoryBytes?: number;
  /**
   * Output file-size cap in bytes, enforced best-effort on POSIX hosts via
   * `ulimit -f` (parity with adk-python's `RLIMIT_FSIZE`). Ignored elsewhere.
   */
  maxFileSizeBytes?: number;
  /**
   * Per-user process-count cap, enforced best-effort on POSIX hosts via
   * `ulimit -u` (parity with adk-python's `RLIMIT_NPROC`). Ignored elsewhere.
   */
  maxChildProcesses?: number;
}

/**
 * Returns whether the given platform is POSIX-like (anything other than
 * `win32`), defaulting to the current process platform. Non-POSIX hosts lack
 * `/bin/bash` and the `ulimit` builtin, so the tool refuses to run there.
 */
export function isPosixPlatform(platform: string = process.platform): boolean {
  return platform !== 'win32';
}

/**
 * Builds the `ulimit` prelude that applies a policy's resource limits to the
 * spawned subprocess, best-effort.
 *
 * Core dumps are always disabled (`ulimit -c 0`) for parity with adk-python's
 * unconditional `RLIMIT_CORE=(0, 0)`. Only requested limits are appended. Each
 * fragment redirects its stderr to `/dev/null` so that a rejected limit (e.g.
 * one exceeding the host's hard limit) neither aborts the user's command nor
 * pollutes its captured stderr — matching the reference's caught-and-logged
 * best-effort behavior. Fragments are joined with `;` (not `&&`) by the caller
 * for the same reason.
 */
export function buildResourceLimitCommands(policy: BashToolPolicy): string[] {
  const commands = ['ulimit -c 0 2>/dev/null'];
  if (policy.maxMemoryBytes) {
    commands.push(
      `ulimit -v ${Math.floor(policy.maxMemoryBytes / BYTES_PER_KIB)} 2>/dev/null`,
    );
  }
  if (policy.maxFileSizeBytes) {
    commands.push(
      `ulimit -f ${Math.floor(policy.maxFileSizeBytes / BYTES_PER_KIB)} 2>/dev/null`,
    );
  }
  if (policy.maxChildProcesses) {
    commands.push(`ulimit -u ${policy.maxChildProcesses} 2>/dev/null`);
  }
  return commands;
}

export function validateCommand(
  command: string,
  policy: BashToolPolicy,
): string | null {
  const stripped = command.trim();
  if (!stripped) {
    return 'Command is required.';
  }

  for (const op of policy.blockedOperators ?? []) {
    if (command.includes(op)) {
      return `Command contains blocked operator: ${op}`;
    }
  }

  const allowedPrefixes = policy.allowedCommandPrefixes ?? ['*'];
  if (allowedPrefixes.some((p) => p === '*' || stripped.startsWith(p)))
    return null;

  return `Command blocked. Permitted prefixes are: ${allowedPrefixes.join(', ')}`;
}

export interface ExecuteBashToolParams {
  workspace?: string;
  policy?: BashToolPolicy;
}

export class ExecuteBashTool extends BaseTool {
  private workspace: string;
  private policy: BashToolPolicy;

  constructor(params?: ExecuteBashToolParams) {
    const policy = {
      allowedCommandPrefixes: ['*'],
      blockedOperators: [],
      timeoutSeconds: 30,
      ...params?.policy,
    };
    const allowedHint = policy.allowedCommandPrefixes.includes('*')
      ? 'any command'
      : `commands matching prefixes: ${policy.allowedCommandPrefixes.join(', ')}`;
    super({
      name: 'execute_bash',
      description: `Executes a bash command with the working directory set to the workspace. Allowed: ${allowedHint}. All commands require user confirmation.`,
    });
    this.workspace = params?.workspace ?? process.cwd();
    this.policy = policy;
  }

  override _getDeclaration(): FunctionDeclaration | undefined {
    return {
      name: this.name,
      description: this.description,
      parameters: {
        type: Type.OBJECT,
        properties: {
          command: {
            type: Type.STRING,
            description: 'The bash command to execute.',
          },
        },
        required: ['command'],
      },
    };
  }

  override async runAsync(request: RunAsyncToolRequest): Promise<unknown> {
    const command = (request.args.command as string) ?? '';

    const validationError = validateCommand(command, this.policy);
    if (validationError) {
      return {error: validationError};
    }

    const {toolContext} = request;
    if (!toolContext.toolConfirmation) {
      toolContext.requestConfirmation({
        hint: `Please approve or reject the bash command: ${command}`,
      });
      toolContext.actions.skipSummarization = true;
      return {
        error:
          'This tool call requires confirmation, please approve or reject.',
      };
    } else if (!toolContext.toolConfirmation.confirmed) {
      return {error: 'This tool call is rejected.'};
    }

    if (!isPosixPlatform()) {
      return {error: UNSUPPORTED_PLATFORM_ERROR};
    }

    const timeoutSeconds = this.policy.timeoutSeconds ?? 30;

    let stdoutData = '';
    let stderrData = '';

    // In node, to mimic start_new_session=True from python and allow killpg, we use detached: true
    const fullCommand = [
      ...buildResourceLimitCommands(this.policy),
      command,
    ].join(' ; ');

    return new Promise((resolve) => {
      let isSettled = false;
      const child = spawn('/bin/bash', ['-c', fullCommand], {
        cwd: this.workspace,
        detached: true,
      });

      let timeoutTimer: ReturnType<typeof setTimeout> | null = null;

      const finishProcess = (
        returncode: number | null,
        errorMessage?: string,
      ) => {
        if (isSettled) return;
        isSettled = true;
        if (timeoutTimer) clearTimeout(timeoutTimer);

        const stdoutTrimmed = stdoutData || '<no stdout captured>';
        const stderrTrimmed = stderrData || '<no stderr captured>';

        resolve({
          ...(!errorMessage && {returncode: returncode ?? -1}),
          ...(errorMessage && {
            error: errorMessage,
            ...(returncode !== null && {returncode}),
          }),
          stdout: stdoutTrimmed,
          stderr: stderrTrimmed,
        });
      };

      child.stdout?.on('data', (data) => {
        stdoutData += data.toString();
      });

      child.stderr?.on('data', (data) => {
        stderrData += data.toString();
      });

      child.on('error', (err) => {
        finishProcess(null, `Execution failed: ${err.message}`);
      });

      child.on('close', (code) => {
        finishProcess(code);
      });

      if (timeoutSeconds > 0) {
        timeoutTimer = setTimeout(() => {
          if (!isSettled) {
            try {
              if (child.pid) {
                process.kill(-child.pid, 'SIGKILL');
              }
            } catch (_e) {
              // Ignore failure to kill
            }
            finishProcess(
              null,
              `Command timed out after ${timeoutSeconds} seconds.`,
            );
          }
        }, timeoutSeconds * 1000);
      }
    });
  }
}
