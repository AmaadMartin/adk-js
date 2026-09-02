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
 * Fails the command when the user supplied both options.
 *
 * The message names `second` first, as adk-python does, because it reports the
 * option that conflicts with one already seen.
 *
 * @param command The command being parsed.
 * @param first The option the command declares first.
 * @param second The option that conflicts with it.
 */
export function validateExclusive(
  command: Command,
  first: string,
  second: string,
): void {
  if (wasSupplied(command, first) && wasSupplied(command, second)) {
    command.error(
      `error: Options '${second}' and '${first}' cannot be set together.`,
      {code: 'commander.conflictingOption'},
    );
  }
}
