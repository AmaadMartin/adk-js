/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {FunctionDeclaration, Type} from '@google/genai';
import {
  ChildProcess,
  ChildProcessWithoutNullStreams,
  spawn,
} from 'node:child_process';

import {Context} from '../agents/context.js';
import {experimental} from '../utils/experimental.js';
import {logger} from '../utils/logger.js';
import {BaseTool, RunAsyncToolRequest} from './base_tool.js';

/** Default wall-clock timeout, in seconds, before a command is killed. */
const DEFAULT_TIMEOUT_SECONDS = 30;
/** Sentinel prefix that, when present in the allowlist, permits any command. */
const ALLOW_ALL_PREFIX = '*';
/** Placeholder returned when a command produces no stdout. */
const NO_STDOUT_CAPTURED = '<no stdout captured>';
/** Placeholder returned when a command produces no stderr. */
const NO_STDERR_CAPTURED = '<no stderr captured>';
/** Intermediate message surfaced while the tool waits for user confirmation. */
const REQUIRES_CONFIRMATION_MESSAGE =
  'This tool call requires confirmation. Please approve or reject the command.';

/**
 * Configuration for allowed bash commands and resource limits.
 *
 * Set {@link BashToolPolicy.allowedCommandPrefixes} to `['*']` to allow all
 * commands (the default), or explicitly list allowed prefixes. All fields are
 * optional; defaults are applied by {@link ExecuteBashTool}.
 */
export interface BashToolPolicy {
  /** Allowed command prefixes. `['*']` (default) allows any command. */
  allowedCommandPrefixes?: string[];
  /**
   * Substrings that, if present in the raw command, reject it (e.g. `'|'`,
   * `';'`, `'&&'`). Checked before the wildcard allow, so blocked operators are
   * enforced even under the default `['*']` allowlist.
   */
  blockedOperators?: string[];
  /** Max wall-clock seconds before the process is killed. Default 30. */
  timeoutSeconds?: number;
  /**
   * POSIX rlimit-style memory cap. Carried for parity with adk-python's
   * `BashToolPolicy` but NOT enforced in this port (see the class docs); Node
   * has no portable `setrlimit` equivalent.
   */
  maxMemoryBytes?: number;
  /**
   * POSIX rlimit-style file-size cap. Carried for parity but NOT enforced in
   * this port.
   */
  maxFileSizeBytes?: number;
  /**
   * POSIX rlimit-style child-process cap. Carried for parity but NOT enforced
   * in this port.
   */
  maxChildProcesses?: number;
}

/** Constructor parameters for {@link ExecuteBashTool}. */
export interface ExecuteBashToolParams {
  /** Directory the command runs in. Defaults to `process.cwd()`. */
  workspace?: string;
  /** Safety policy. Defaults to allow-all with a 30s timeout. */
  policy?: BashToolPolicy;
}

/** Successful (or non-zero exit) execution result. */
interface BashExecutionResult {
  stdout: string;
  stderr: string;
  returncode: number | null;
}

/** Error result returned across the tool boundary (never thrown). */
interface BashErrorResult {
  error: string;
  stdout?: string;
  stderr?: string;
  returncode?: number | null;
}

/**
 * Validates a bash command against a policy.
 *
 * Operates purely on the raw/stripped command string (not on tokens), matching
 * adk-python's `_validate_command` so tokenizer behavior can never weaken the
 * checks. Returns an error string, or `undefined` when the command is allowed.
 */
export function validateCommand(
  command: string,
  policy: BashToolPolicy,
): string | undefined {
  const stripped = command.trim();
  if (!stripped) {
    return 'Command is required.';
  }

  for (const operator of policy.blockedOperators ?? []) {
    if (command.includes(operator)) {
      return `Command contains blocked operator: ${operator}`;
    }
  }

  const allowedPrefixes = policy.allowedCommandPrefixes ?? [ALLOW_ALL_PREFIX];
  if (allowedPrefixes.includes(ALLOW_ALL_PREFIX)) {
    return undefined;
  }

  for (const prefix of allowedPrefixes) {
    if (stripped.startsWith(prefix)) {
      return undefined;
    }
  }

  return `Command blocked. Permitted prefixes are: ${allowedPrefixes.join(', ')}`;
}

/**
 * Splits a command string into argv tokens the way POSIX `shlex.split` does for
 * the common cases, WITHOUT interpreting shell operators.
 *
 * - Splits on unquoted whitespace.
 * - Single quotes `'...'` are literal (no escapes inside).
 * - Double quotes `"..."` are literal, but `\` escapes the next character.
 * - A backslash outside quotes escapes the next character.
 * - Operators (`|`, `;`, `&&`, `` ` ``, `$(`) are NOT special: they become
 *   literal tokens, exactly as `shlex.split` returns them.
 */
export function splitCommand(command: string): string[] {
  const tokens: string[] = [];
  let current = '';
  let inToken = false;

  for (let i = 0; i < command.length; i++) {
    const char = command[i];

    if (char === "'") {
      inToken = true;
      i++;
      while (i < command.length && command[i] !== "'") {
        current += command[i];
        i++;
      }
    } else if (char === '"') {
      inToken = true;
      i++;
      while (i < command.length && command[i] !== '"') {
        if (command[i] === '\\' && i + 1 < command.length) {
          current += command[i + 1];
          i++;
        } else {
          current += command[i];
        }
        i++;
      }
    } else if (char === '\\') {
      inToken = true;
      if (i + 1 < command.length) {
        current += command[i + 1];
        i++;
      }
    } else if (/\s/.test(char)) {
      if (inToken) {
        tokens.push(current);
        current = '';
        inToken = false;
      }
    } else {
      inToken = true;
      current += char;
    }
  }

  if (inToken) {
    tokens.push(current);
  }

  return tokens;
}

/**
 * Kills a detached child's whole process group (POSIX), falling back to killing
 * just the child where process groups are unavailable (e.g. Windows) or already
 * gone.
 */
export function killProcessTree(child: Pick<ChildProcess, 'pid' | 'kill'>) {
  if (child.pid === undefined) {
    return;
  }
  try {
    // A detached child is a group leader whose pgid equals its pid; a negative
    // pid targets that whole group, matching adk-python's os.killpg.
    process.kill(-child.pid, 'SIGKILL');
  } catch {
    try {
      child.kill('SIGKILL');
    } catch {
      // The process already exited; nothing to kill.
    }
  }
}

/**
 * Tool to execute a validated bash command within a workspace directory.
 *
 * Ported from adk-python's `ExecuteBashTool`
 * (`src/google/adk/tools/bash_tool.py`). The model supplies a `command`, which
 * is validated against a {@link BashToolPolicy}, gated behind user confirmation,
 * then run in the workspace directory (with no shell interpretation) returning
 * `stdout` / `stderr` / `returncode`.
 *
 * Intentional divergences from the Python reference:
 * - It does NOT refuse non-POSIX hosts: `child_process.spawn` is
 *   cross-platform, so the tool runs on any platform Node supports.
 * - The `maxMemoryBytes` / `maxFileSizeBytes` / `maxChildProcesses` policy
 *   fields are carried for API parity but NOT enforced, because Node has no
 *   portable equivalent of the POSIX `resource` module used by the reference's
 *   `preexec_fn`. A warning is logged when any of them is set.
 */
@experimental
export class ExecuteBashTool extends BaseTool {
  private readonly workspace: string;
  private readonly policy: BashToolPolicy;

  constructor({workspace, policy = {}}: ExecuteBashToolParams = {}) {
    const allowedPrefixes = policy.allowedCommandPrefixes ?? [ALLOW_ALL_PREFIX];
    const allowedHint = allowedPrefixes.includes(ALLOW_ALL_PREFIX)
      ? 'any command'
      : `commands matching prefixes: ${allowedPrefixes.join(', ')}`;
    super({
      name: 'execute_bash',
      description:
        'Executes a bash command with the working directory set to the ' +
        `workspace. Allowed: ${allowedHint}. All commands require user ` +
        'confirmation.',
    });
    this.workspace = workspace ?? process.cwd();
    this.policy = policy;

    const rlimitFields = [
      policy.maxMemoryBytes,
      policy.maxFileSizeBytes,
      policy.maxChildProcesses,
    ];
    if (rlimitFields.some((value) => value !== undefined)) {
      logger.warn(
        'ExecuteBashTool: maxMemoryBytes, maxFileSizeBytes and ' +
          'maxChildProcesses are not enforced in the JS port (Node has no ' +
          'portable rlimit equivalent) and will be ignored.',
      );
    }
  }

  override _getDeclaration(): FunctionDeclaration {
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

  override async runAsync({
    args,
    toolContext,
  }: RunAsyncToolRequest): Promise<unknown> {
    const command = (args['command'] as string | undefined) ?? '';

    // Static validation runs before confirmation and before execution, so a
    // policy-violating command is rejected without prompting the user. It also
    // rejects a missing/empty command with "Command is required.".
    const error = validateCommand(command, this.policy);
    if (error) {
      return {error};
    }

    const pending = this.enforceConfirmation(command, toolContext);
    if (pending) {
      return pending;
    }

    return this.execute(command);
  }

  /**
   * Requires user confirmation before executing an arbitrary command. Returns
   * an intermediate/rejection result when execution must not proceed, or
   * `undefined` once the command has been confirmed.
   */
  private enforceConfirmation(
    command: string,
    toolContext: Context,
  ): {partial: string} | BashErrorResult | undefined {
    if (!toolContext.toolConfirmation) {
      toolContext.requestConfirmation({
        hint: `Please approve or reject the bash command: ${command}`,
      });
      toolContext.actions.skipSummarization = true;
      return {partial: REQUIRES_CONFIRMATION_MESSAGE};
    }
    if (!toolContext.toolConfirmation.confirmed) {
      return {error: 'This tool call is rejected.'};
    }
    return undefined;
  }

  /**
   * Spawns the command (without a shell) in the workspace, capturing output and
   * enforcing the policy timeout. Never rejects: failures resolve to an error
   * result so they surface across the tool boundary.
   */
  private execute(
    command: string,
  ): Promise<BashExecutionResult | BashErrorResult> {
    const [program, ...programArgs] = splitCommand(command);
    const timeoutSeconds =
      this.policy.timeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS;

    return new Promise((resolve) => {
      let child: ChildProcessWithoutNullStreams;
      try {
        child = spawn(program, programArgs, {
          cwd: this.workspace,
          detached: true,
        });
      } catch (e) {
        resolve({
          error: `Execution failed: ${(e as Error).message}`,
          stdout: NO_STDOUT_CAPTURED,
          stderr: NO_STDERR_CAPTURED,
        });
        return;
      }

      let stdout = '';
      let stderr = '';
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        killProcessTree(child);
      }, timeoutSeconds * 1000);

      child.stdout.on('data', (data) => {
        stdout += data.toString();
      });
      child.stderr.on('data', (data) => {
        stderr += data.toString();
      });

      // spawn emits 'error' (e.g. ENOENT) before 'close'; resolving in both is
      // safe because the first settle wins and later resolves are ignored. A
      // spawn error means the process never ran, so no output was captured.
      child.on('error', (err) => {
        clearTimeout(timer);
        resolve({
          error: `Execution failed: ${err.message}`,
          stdout: NO_STDOUT_CAPTURED,
          stderr: NO_STDERR_CAPTURED,
        });
      });

      child.on('close', (code) => {
        clearTimeout(timer);
        const capturedStdout = stdout || NO_STDOUT_CAPTURED;
        const capturedStderr = stderr || NO_STDERR_CAPTURED;
        if (timedOut) {
          resolve({
            error: `Command timed out after ${timeoutSeconds} seconds.`,
            stdout: capturedStdout,
            stderr: capturedStderr,
            returncode: code,
          });
          return;
        }
        resolve({
          stdout: capturedStdout,
          stderr: capturedStderr,
          returncode: code,
        });
      });
    });
  }
}
