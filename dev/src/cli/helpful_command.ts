/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Full help instead of a one-line usage error.
 *
 * A port of adk-python's `HelpfulCommand`. Commander answers a missing
 * argument with one line and exit code 1, which tells a first-time user
 * nothing about what the command wanted. adk-python prints the whole help
 * text, then a single error line naming the parameter, and exits 2.
 */

import {Command, CommanderError} from 'commander';

/** The exit code adk-python uses for a missing parameter. */
const MISSING_PARAMETER_EXIT_CODE = 2;

/** The commander error codes that report a parameter the user left out. */
const MISSING_PARAMETER_CODES: ReadonlySet<string> = new Set([
  'commander.missingArgument',
  'commander.missingMandatoryOptionValue',
]);

/**
 * Returns the parameter a missing-parameter error names, upper-cased as
 * adk-python prints it, or undefined when the error reports something else.
 *
 * Commander names the parameter only inside its message: `'agent'` for an
 * argument and `'--out_file <path>'` for an option, whose parameter name is
 * the long flag.
 */
function missingParameterName(err: CommanderError): string | undefined {
  if (!MISSING_PARAMETER_CODES.has(err.code)) {
    return undefined;
  }
  const quoted = /'([^']+)'/.exec(err.message)?.[1];
  if (quoted === undefined) {
    return undefined;
  }
  return (/--([^\s,<[]+)/.exec(quoted)?.[1] ?? quoted).toUpperCase();
}

/**
 * Makes a command print its full help when a required parameter is missing.
 *
 * Commander writes its own error line before it exits, so that line is held
 * back and only released for the errors this function does not rewrite.
 *
 * @param command The command to install the behaviour on.
 * @return The same command, so it can be chained.
 */
export function applyHelpfulCommand(command: Command): Command {
  let heldBackError: string | undefined;
  command.configureOutput({
    outputError: (message) => {
      heldBackError = message;
    },
  });
  command.exitOverride((err) => {
    const parameterName = missingParameterName(err);
    const released = heldBackError;
    heldBackError = undefined;
    if (parameterName === undefined) {
      if (released !== undefined) {
        process.stderr.write(released);
      }
      // Returning hands back to commander, which exits as it normally would.
      return;
    }
    process.stdout.write(command.helpInformation());
    process.stderr.write(
      `\nError: Missing required argument: ${parameterName}\n`,
    );
    process.exit(MISSING_PARAMETER_EXIT_CODE);
  });
  return command;
}
