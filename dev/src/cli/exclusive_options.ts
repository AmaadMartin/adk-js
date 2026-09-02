/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Command} from 'commander';

/** The exit code click uses for a usage error, and adk-python inherits. */
export const USAGE_ERROR_EXIT_CODE = 2;

/**
 * Refuses an invocation that sets more than one of `names`.
 *
 * adk-python does this with a per-option `validate_exclusive` callback. The
 * message names the option that triggered the conflict first and the option
 * already seen second, in the order the options are declared.
 *
 * The check runs before the action, so a refused invocation never reaches the
 * command body.
 */
export function applyExclusiveOptions(
  command: Command,
  names: readonly string[],
): Command {
  return command.hook('preAction', (_program, actionCommand) => {
    let seen: string | undefined;
    for (const name of names) {
      if (actionCommand.getOptionValue(name) === undefined) {
        continue;
      }
      if (seen !== undefined) {
        actionCommand.error(
          `error: Options '${name}' and '${seen}' cannot be set together.`,
          {exitCode: USAGE_ERROR_EXIT_CODE, code: 'adk.exclusiveOptions'},
        );
      }
      seen = name;
    }
  });
}
