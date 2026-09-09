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
import {collectChildOutput, splitCommand} from '../utils/shell_utils.js';
import {BaseTool, RunAsyncToolRequest} from './base_tool.js';

/** Sentinel prefix that allows any command. Not a glob. */
const ALLOW_ANY_COMMAND = '*';

/** Wall-clock budget applied when the policy does not set one. */
const DEFAULT_TIMEOUT_SECONDS = 30;

const NO_STDOUT_CAPTURED = '<no stdout captured>';
const NO_STDERR_CAPTURED = '<no stderr captured>';

/**
 * Allowed commands and the time budget for {@link ExecuteBashTool}.
 *
 * A prefix allowlist is a coarse filter, not a sandbox: it compares the start
 * of the trimmed command string, so `cat` also admits `catalog`.
 *
 * adk-python's three resource limits are absent because Node has no
 * `setrlimit` and no `preexec_fn`, so nothing here could enforce them.
 */
export interface BashToolPolicy {
  /** Allowed command prefixes. `['*']` (the default) allows any command. */
  allowedCommandPrefixes?: readonly string[];
  /**
   * Substrings that refuse a command outright. Empty by default.
   *
   * This is the only filter that reads a command's arguments, so it is how a
   * policy says "`git`, but never `push --force`". It matches the raw string,
   * so the substring refuses the command even inside a quoted argument.
   */
  blockedOperators?: readonly string[];
  /** Wall-clock budget in seconds. `null` disables the timeout. */
  timeoutSeconds?: number | null;
}

/** Options for {@link ExecuteBashTool}. */
export interface ExecuteBashToolOptions {
  /** Directory used as the command's `cwd`. Defaults to `process.cwd()`. */
  workspace?: string;
  /** Policy to enforce. Defaults to any command with a 30 second timeout. */
  policy?: BashToolPolicy;
}

/** A {@link BashToolPolicy} with every defaulted field filled in. */
export type ResolvedBashToolPolicy = Required<BashToolPolicy>;

/**
 * Fills in the defaults a caller left out.
 *
 * Each field defaults on its own, so an explicit `undefined` — what an
 * optional config field spreads to — resolves the same way an absent one does.
 */
function resolvePolicy({
  allowedCommandPrefixes = [ALLOW_ANY_COMMAND],
  blockedOperators = [],
  timeoutSeconds = DEFAULT_TIMEOUT_SECONDS,
}: BashToolPolicy): ResolvedBashToolPolicy {
  return {allowedCommandPrefixes, blockedOperators, timeoutSeconds};
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
  // Before the allow-any check, so a denylist still applies under the default
  // policy. Matched against the raw command, so padding cannot hide an entry.
  const blocked = policy.blockedOperators.find((op) => command.includes(op));
  if (blocked !== undefined) {
    return `Command contains blocked operator: ${blocked}`;
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
 * SIGKILLs the child's whole process group.
 *
 * The cleanup path calls this once the child has closed, when the group is
 * normally empty already and the kill throws `ESRCH`. That is the expected
 * case rather than a fault, so nothing is reported: the caller holds the
 * command's result and cannot act on a failed reap.
 */
function killProcessGroup(pid: number | undefined): void {
  if (pid === undefined) {
    return;
  }
  try {
    process.kill(-pid, 'SIGKILL');
  } catch {
    // The group is gone, which is the outcome this asks for.
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
 * privileges and environment. The policy filters reduce the blast radius,
 * they do not sandbox the command.
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
        'Executes a command with the working directory set to the ' +
        `workspace. Allowed: ${describeAllowed(policy)}. All commands ` +
        'require user confirmation. No shell runs the command, so `|`, ' +
        '`;`, `&&`, `$()`, redirection and globs are passed to the program ' +
        'as literal arguments instead of being interpreted.',
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
            description:
              'The command to execute, as a program and its arguments. ' +
              'Quoting follows POSIX shell rules, but no shell interprets ' +
              'the result, so it cannot pipe, redirect or chain.',
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
    if (typeof command !== 'string') {
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
    const {timeoutSeconds} = this.policy;
    try {
      const [file, ...rest] = splitCommand(command);
      const child = spawn(file, rest, {
        cwd: this.workspace,
        env: process.env,
        detached: true,
        // The child must not read the host agent's stdin: for a CLI agent a
        // command that waits on it hangs the whole process.
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      try {
        const {stdout, stderr, returncode, timedOut} = await collectChildOutput(
          child,
          timeoutSeconds,
          () => killProcessGroup(child.pid),
        );
        const output = {
          stdout: stdout || NO_STDOUT_CAPTURED,
          stderr: stderr || NO_STDERR_CAPTURED,
          returncode,
        };
        return timedOut
          ? {
              error: `Command timed out after ${timeoutSeconds} seconds.`,
              ...output,
            }
          : output;
      } finally {
        killProcessGroup(child.pid);
      }
    } catch (e: unknown) {
      logger.error(`ExecuteBashTool execution failed: ${formatError(e)}`);
      return {
        error: `Execution failed: ${formatError(e)}`,
        stdout: NO_STDOUT_CAPTURED,
        stderr: NO_STDERR_CAPTURED,
      };
    }
  }
}
