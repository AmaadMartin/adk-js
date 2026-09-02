/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Command, CommanderError} from 'commander';
import {vi} from 'vitest';

/**
 * Makes a program and every subcommand of it throw instead of exiting.
 *
 * A subcommand copies the exit override when it is created, so one installed
 * on the program afterwards does not reach the subcommands already built.
 */
export function applyExitOverride(program: Command): Command {
  program.exitOverride();
  for (const command of program.commands) {
    command.exitOverride();
  }
  return program;
}

/**
 * Runs `command`, returning the error commander raised, or undefined when the
 * command ran. Stderr is silenced, because a rejected invocation writes to it.
 */
export async function runExpectingError(
  command: Command,
  argv: string[],
): Promise<CommanderError | undefined> {
  const stderr = vi
    .spyOn(process.stderr, 'write')
    .mockImplementation(() => true);
  try {
    await command.parseAsync(argv, {from: 'user'});
    return undefined;
  } catch (error: unknown) {
    if (error instanceof CommanderError) {
      return error;
    }
    throw error;
  } finally {
    stderr.mockRestore();
  }
}
