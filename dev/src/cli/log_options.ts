/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {LogLevel} from '@google/adk';
import {Command, Option} from 'commander';
import {createChoiceOption} from './choice_options.js';

/**
 * Log level names `--log_level` accepts.
 *
 * `DEBUG`, `INFO`, `WARNING`, `ERROR` and `CRITICAL` are the names adk-python
 * declares in its `LOG_LEVELS` choice. `WARN` is kept because the adk-js CLI
 * accepted it before this list closed.
 */
export const LOG_LEVEL_CHOICES = [
  'DEBUG',
  'INFO',
  'WARNING',
  'WARN',
  'ERROR',
  'CRITICAL',
] as const;

/** The name `--log_level` falls back to when the flag is absent. */
export const DEFAULT_LOG_LEVEL_NAME = 'INFO';

/**
 * Maps an accepted name to a level the ADK logger understands.
 *
 * `WARNING` and `CRITICAL` have no distinct `LogLevel`, so they collapse onto
 * the nearest one: Python's `CRITICAL` only ever reaches an error handler.
 */
const LOG_LEVEL_MAP: Record<string, LogLevel> = {
  'DEBUG': LogLevel.DEBUG,
  'INFO': LogLevel.INFO,
  'WARNING': LogLevel.WARN,
  'WARN': LogLevel.WARN,
  'ERROR': LogLevel.ERROR,
  'CRITICAL': LogLevel.ERROR,
};

export const VERBOSE_OPTION = new Option(
  '-v, --verbose',
  'Optional. Log at debug level. Shorthand for --log_level DEBUG',
).default(false);

export const LOG_LEVEL_OPTION = createChoiceOption(
  '--log_level <string>',
  'Optional. The log level of the server',
  LOG_LEVEL_CHOICES,
).default(DEFAULT_LOG_LEVEL_NAME);

/**
 * The resolved logging flags of a command.
 *
 * `--verbose` is not here: `applyVerboseLogLevel` folds it into `log_level`
 * before the action runs, so an action reads one field.
 */
export interface LogLevelOptions {
  log_level?: string;
}

/**
 * Makes `--verbose` a shorthand for `--log_level DEBUG` on every command.
 *
 * `--verbose` only raises a `--log_level` the user left at its default, so an
 * explicit `--log_level` wins. adk-python draws the same line with
 * `ParameterSource.DEFAULT` in its `_logging_options` decorator.
 *
 * The hook belongs on the program: commander runs a `preAction` hook for the
 * command it is registered on and for every subcommand of it, so one
 * registration covers the whole CLI.
 */
export function applyVerboseLogLevel(program: Command): Command {
  return program.hook('preAction', (_program, actionCommand) => {
    if (
      actionCommand.getOptionValue('verbose') === true &&
      actionCommand.getOptionValueSource('log_level') !== 'cli'
    ) {
      actionCommand.setOptionValue('log_level', 'DEBUG');
    }
  });
}

/** Resolves the log level a command was asked for. */
export function getLogLevelFromOptions(options: LogLevelOptions): LogLevel {
  // `??`, not `||`: LogLevel.DEBUG is 0, so `||` fell through to INFO and made
  // `--log_level debug` a silent no-op. An absent flag misses the map and takes
  // the same fallback.
  return LOG_LEVEL_MAP[options.log_level?.toUpperCase() ?? ''] ?? LogLevel.INFO;
}
