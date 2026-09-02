/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Rejects options a command cannot honour together.
 *
 * A port of adk-python's `validate_exclusive`. Commander's own `conflicts()`
 * declares the pair on the option, which reports a different message; this
 * keeps the wording the two SDKs share.
 */

import {Command} from 'commander';

/**
 * Reports whether the user supplied the option, rather than commander filling
 * in its default. An explicit empty value still counts as supplied.
 */
function wasSupplied(command: Command, name: string): boolean {
  const source = command.getOptionValueSource(name);
  return source !== undefined && source !== 'default';
}

/**
 * Fails the command when the user supplied more than one of `names`.
 *
 * The message names the later option first, as adk-python does, because it
 * reports the option that conflicts with one already seen.
 *
 * @param command The command being parsed.
 * @param names The option names, in the order the command declares them.
 */
export function validateExclusive(command: Command, names: string[]): void {
  const supplied = names.filter((name) => wasSupplied(command, name));
  if (supplied.length > 1) {
    command.error(
      `error: Options '${supplied[1]}' and '${supplied[0]}' cannot be set ` +
        `together.`,
      {code: 'commander.conflictingOption'},
    );
  }
}
