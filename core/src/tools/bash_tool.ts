/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {FunctionDeclaration, Type} from '@google/genai';
import {spawn} from 'node:child_process';
import {formatError} from '../utils/error_utils.js';
import {experimental} from '../utils/experimental.js';
import {logger} from '../utils/logger.js';
import {splitCommand, toReturnCode} from '../utils/shell_utils.js';
import {BaseTool, RunAsyncToolRequest} from './base_tool.js';

/** Sentinel prefix that allows any command. Not a glob. */
const ALLOW_ANY_COMMAND = '*';

/** Wall-clock budget applied when the policy does not set one. */
const DEFAULT_TIMEOUT_SECONDS = 30;

/** `ulimit -v` and `ulimit -f` count 1024-byte units under bash. */
const BYTES_PER_KIB = 1024;

const NO_STDOUT_CAPTURED = '<no stdout captured>';
const NO_STDERR_CAPTURED = '<no stderr captured>';

/**
 * Allowed commands and resource limits for {@link ExecuteBashTool}.
 *
 * A prefix allowlist is a coarse filter, not a sandbox: it compares the start
 * of the trimmed command string, so `cat` also admits `catalog`.
 */
export interface BashToolPolicy {
  /** Allowed command prefixes. `['*']` (the default) allows any command. */
  allowedCommandPrefixes?: readonly string[];
  /** Substrings that reject a command outright. Empty by default. */
  blockedOperators?: readonly string[];
  /** Wall-clock budget in seconds. `null` disables the timeout. */
  timeoutSeconds?: number | null;
  /** Address-space limit for the child, in bytes. */
  maxMemoryBytes?: number;
  /** Maximum file size the child may write, in bytes. */
  maxFileSizeBytes?: number;
  /** Maximum number of processes the child's user may have. */
  maxChildProcesses?: number;
}

/** Options for {@link ExecuteBashTool}. */
export interface ExecuteBashToolOptions {
  /** Directory used as the command's `cwd`. Defaults to `process.cwd()`. */
  workspace?: string;
  /** Policy to enforce. Defaults to any command with a 30 second timeout. */
  policy?: BashToolPolicy;
}

/** A {@link BashToolPolicy} with every defaulted field filled in. */
export interface ResolvedBashToolPolicy extends BashToolPolicy {
  allowedCommandPrefixes: readonly string[];
  blockedOperators: readonly string[];
  timeoutSeconds: number | null;
}

const DEFAULT_BASH_TOOL_POLICY: ResolvedBashToolPolicy = {
  allowedCommandPrefixes: [ALLOW_ANY_COMMAND],
  blockedOperators: [],
  timeoutSeconds: DEFAULT_TIMEOUT_SECONDS,
};

/** Fills in the defaults a caller left out. */
function resolvePolicy(policy: BashToolPolicy): ResolvedBashToolPolicy {
  const {timeoutSeconds = DEFAULT_TIMEOUT_SECONDS} = policy;
  return {...DEFAULT_BASH_TOOL_POLICY, ...policy, timeoutSeconds};
}

/** Renders the `Allowed:` clause of the tool description. */
function describeAllowed(policy: ResolvedBashToolPolicy): string {
  return policy.allowedCommandPrefixes.includes(ALLOW_ANY_COMMAND)
    ? 'any command'
    : `commands matching prefixes: ${policy.allowedCommandPrefixes.join(', ')}`;
}

/**
 * Returns an error message if `command` violates `policy`, else `undefined`.
 *
 * @param command The command line the model asked to run.
 * @param policy The policy to check it against.
 * @return The message to report to the model, or `undefined` when allowed.
 */
export function validateCommand(
  command: string,
  policy: ResolvedBashToolPolicy,
): string | undefined {
  const stripped = command.trim();
  if (!stripped) {
    return 'Command is required.';
  }
  for (const operator of policy.blockedOperators) {
    if (command.includes(operator)) {
      return `Command contains blocked operator: ${operator}`;
    }
  }
  if (policy.allowedCommandPrefixes.includes(ALLOW_ANY_COMMAND)) {
    return undefined;
  }
  if (policy.allowedCommandPrefixes.some((p) => stripped.startsWith(p))) {
    return undefined;
  }
  const allowed = policy.allowedCommandPrefixes.join(', ');
  return `Command blocked. Permitted prefixes are: ${allowed}`;
}

/**
 * Converts bytes to the KiB unit bash's `ulimit` uses, rounding up so that a
 * small positive limit never becomes `0`, which means "nothing at all".
 */
function toKib(bytes: number): number {
  return Math.ceil(bytes / BYTES_PER_KIB);
}

/**
 * Builds the argv to spawn, wrapping `argv` in a `ulimit` prologue when the
 * policy sets at least one resource limit.
 *
 * Node cannot call `setrlimit` on a child, so the limits are applied by a bash
 * prologue instead. The prologue ends with `exec "$@"`, so the command itself
 * is still passed as argv and is never re-parsed by the shell. Each `ulimit`
 * discards its own stderr: a limit the kernel refuses must not pollute the
 * command's output.
 *
 * @param argv The tokenized command.
 * @param policy The policy whose limits to apply.
 * @return The argv to spawn, unchanged when no limit is set.
 */
export function buildSpawnArgv(
  argv: readonly string[],
  policy: ResolvedBashToolPolicy,
): string[] {
  const {maxMemoryBytes, maxFileSizeBytes, maxChildProcesses} = policy;
  if (!maxMemoryBytes && !maxFileSizeBytes && !maxChildProcesses) {
    return [...argv];
  }
  const limits = ['ulimit -c 0'];
  if (maxMemoryBytes) {
    limits.push(`ulimit -v ${toKib(maxMemoryBytes)}`);
  }
  if (maxFileSizeBytes) {
    limits.push(`ulimit -f ${toKib(maxFileSizeBytes)}`);
  }
  if (maxChildProcesses) {
    limits.push(`ulimit -u ${maxChildProcesses}`);
  }
  const prologue = limits.map((l) => `${l} 2>/dev/null; `).join('');
  return ['bash', '-c', `${prologue}exec "$@"`, 'bash', ...argv];
}

/** Decodes captured output, reporting an empty capture as `placeholder`. */
function decodeOutput(chunks: Buffer[], placeholder: string): string {
  // Decode once, so a multi-byte character split across two chunks is not
  // corrupted. Invalid bytes become U+FFFD, matching Python's
  // `errors='replace'`.
  const text = Buffer.concat(chunks).toString('utf-8');
  return text === '' ? placeholder : text;
}

/** SIGKILLs the child's whole process group; a group already gone is fine. */
function killProcessGroup(pid: number | undefined): void {
  if (pid === undefined) {
    return;
  }
  try {
    process.kill(-pid, 'SIGKILL');
  } catch (e: unknown) {
    logger.debug(`Failed to kill process group ${pid}: ${formatError(e)}`);
  }
}

/**
 * Runs a validated bash command in a workspace directory, behind a mandatory
 * user confirmation.
 *
 * The command is tokenized and executed directly, without a shell, so an
 * operator such as `;` or `|` reaches the program as a literal argument.
 * Every call needs an approved `toolConfirmation`; there is no option that
 * turns the gate off.
 *
 * WARNING: an approved command runs on the host with the agent process's own
 * privileges and environment. The policy filters and the resource limits
 * reduce the blast radius, they do not sandbox the command.
 */
@experimental
export class ExecuteBashTool extends BaseTool {
  private readonly workspace: string;
  private readonly policy: ResolvedBashToolPolicy;

  constructor(options: ExecuteBashToolOptions = {}) {
    const policy = resolvePolicy(options.policy ?? {});
    super({
      name: 'execute_bash',
      description:
        'Executes a bash command with the working directory set to the ' +
        `workspace. Allowed: ${describeAllowed(policy)}. All commands ` +
        'require user confirmation.',
    });
    this.workspace = options.workspace ?? process.cwd();
    this.policy = policy;
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

  /** Every command this tool runs is gated, so the answer is unconditional. */
  override async checkRequireConfirmation(): Promise<boolean> {
    return true;
  }

  override async runAsync({
    args,
    toolContext,
  }: RunAsyncToolRequest): Promise<unknown> {
    const command = args['command'];
    if (typeof command !== 'string' || !command) {
      return {error: 'Command is required.'};
    }

    const validationError = validateCommand(command, this.policy);
    if (validationError) {
      return {error: validationError};
    }

    const confirmation = toolContext.toolConfirmation;
    if (!confirmation) {
      toolContext.requestConfirmation({
        hint: `Please approve or reject the bash command: ${command}`,
      });
      toolContext.actions.skipSummarization = true;
      return {
        error:
          'This tool call requires confirmation, please approve or reject.',
      };
    }
    if (!confirmation.confirmed) {
      return {error: 'This tool call is rejected.'};
    }

    // Read at call time, not at module load, so the branch stays testable.
    if (process.platform === 'win32') {
      return {error: 'ExecuteBashTool is only supported on POSIX systems.'};
    }

    return this.execute(command);
  }

  /**
   * Spawns `command` and collects its output.
   *
   * The child gets its own process group, so a timeout can kill the whole tree
   * rather than just the process that was spawned. A grandchild that survives
   * `SIGKILL` is out of the tool's control.
   */
  private async execute(command: string): Promise<unknown> {
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    const {timeoutSeconds} = this.policy;
    try {
      const [file, ...rest] = buildSpawnArgv(
        splitCommand(command),
        this.policy,
      );
      const child = spawn(file, rest, {
        cwd: this.workspace,
        env: process.env,
        detached: true,
        // The child must not read the host agent's stdin: for a CLI agent a
        // command that waits on it hangs the whole process.
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      child.stdout.on('data', (chunk: Buffer) => stdoutChunks.push(chunk));
      child.stderr.on('data', (chunk: Buffer) => stderrChunks.push(chunk));

      let timedOut = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      if (timeoutSeconds !== null) {
        timer = setTimeout(() => {
          timedOut = true;
          killProcessGroup(child.pid);
        }, timeoutSeconds * 1000);
      }

      try {
        const returncode = await new Promise<number>((resolve, reject) => {
          // 'close' rather than 'exit': the stdio streams are drained by then.
          child.on('close', (code, signal) =>
            resolve(toReturnCode(code, signal)),
          );
          child.on('error', reject);
        });
        const output = {
          stdout: decodeOutput(stdoutChunks, NO_STDOUT_CAPTURED),
          stderr: decodeOutput(stderrChunks, NO_STDERR_CAPTURED),
          returncode,
        };
        return timedOut
          ? {
              error: `Command timed out after ${timeoutSeconds} seconds.`,
              ...output,
            }
          : output;
      } finally {
        clearTimeout(timer);
        killProcessGroup(child.pid);
      }
    } catch (e: unknown) {
      logger.error(`ExecuteBashTool execution failed: ${formatError(e)}`);
      return {
        error: `Execution failed: ${formatError(e)}`,
        stdout: decodeOutput(stdoutChunks, NO_STDOUT_CAPTURED),
        stderr: decodeOutput(stderrChunks, NO_STDERR_CAPTURED),
      };
    }
  }
}
