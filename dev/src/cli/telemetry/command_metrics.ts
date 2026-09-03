/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Command, Option} from 'commander';
import {EventEmitter} from 'node:events';
import {AdkLogger} from '../../utils/logger.js';
import {readTelemetryConsent} from './consent.js';
import {MetricsCollector} from './metrics_collector.js';

const logger = new AdkLogger({label: 'ADK CLI', colorize: {all: true}});

/**
 * The only token treated as a help request. adk-js binds `-h` to `--host` on
 * its server subcommands, so `adk web -h 0.0.0.0` is a real run.
 */
const HELP_FLAG = '--help';

/**
 * The group that manages consent, excluded because recording its own runs
 * would be circular. It is registered on the branch this change merges into,
 * not on the one it is cut from.
 */
const TELEMETRY_COMMAND = 'telemetry';

/** Injection points. Every one defaults to the real thing the CLI uses. */
export interface CommandMetricsDeps {
  readConsent?: () => boolean | undefined;
  collector?: MetricsCollector;
  /** Monotonic clock, in milliseconds. */
  now?: () => number;
  /**
   * Event source the exit hook attaches to; defaults to `process`. Tests pass
   * their own emitter so they never have to emit a real process `exit`.
   */
  events?: EventEmitter;
}

/**
 * Times this invocation and queues one record when the process exits.
 *
 * Nothing is measured, no listener is registered and no file is created unless
 * the user opted in. Help requests and the `telemetry` group are excluded,
 * matching adk-python's `TelemetryGroup`.
 *
 * The record is written from an `exit` listener, so every write it makes is
 * synchronous: a command that calls `process.exit()` gives nothing a chance to
 * await. `uncaughtExceptionMonitor` observes a crash without changing what
 * Node does about it, which is how the error name reaches the record.
 *
 * Returns a function that removes the listeners again.
 */
export function instrumentCommandMetrics(
  program: Command,
  argv: readonly string[],
  deps: CommandMetricsDeps = {},
): () => void {
  if (argv.includes(HELP_FLAG)) {
    return noop;
  }

  const [command, subcommand] = resolveCommandPath(program, argv);
  if (command === '' || command === TELEMETRY_COMMAND) {
    return noop;
  }

  const readConsent = deps.readConsent ?? readTelemetryConsent;
  if (readConsent() !== true) {
    return noop;
  }

  const now = deps.now ?? (() => performance.now());
  const events = deps.events ?? process;
  const startedAt = now();
  let flags: string[] = [];
  let exceptionType = '';

  program.hook('preAction', (_thisCommand, actionCommand) => {
    flags = gatherFlags(actionCommand);
  });

  const onError = (error: unknown) => {
    exceptionType = errorName(error);
  };
  const onExit = (exitCode: number) => {
    try {
      const collector = deps.collector ?? new MetricsCollector();
      collector.recordCommandRun({
        command,
        subcommand,
        exit_code: exitCode,
        duration_ms: Math.trunc(now() - startedAt),
        flags,
        exception_type: exceptionType,
      });
    } catch (error: unknown) {
      logger.debug(`Failed to record the CLI invocation: ${String(error)}`);
    }
  };

  events.on('uncaughtExceptionMonitor', onError);
  events.once('exit', onExit);

  return () => {
    events.off('uncaughtExceptionMonitor', onError);
    events.off('exit', onExit);
  };
}

function noop(): void {}

/**
 * Walks the arguments against the registered commands and returns the
 * `[command, subcommand]` pair they select. A token that names no command is
 * skipped, so a flag written before the command does not hide it.
 */
function resolveCommandPath(
  program: Command,
  argv: readonly string[],
): [string, string] {
  const resolved: string[] = [];
  let current = program;
  for (const arg of argv) {
    const next = current.commands.find((candidate) => candidate.name() === arg);
    if (next === undefined) {
      continue;
    }
    resolved.push(arg);
    if (next.commands.length === 0) {
      break;
    }
    current = next;
  }
  return [resolved[0] ?? '', resolved[1] ?? ''];
}

/**
 * Collects the names of the options and positional arguments the user
 * supplied. Values never leave the process: an option contributes its flag,
 * and a positional argument contributes its declared name in angle brackets.
 */
function gatherFlags(command: Command): string[] {
  const flags = command.options
    .filter(
      (option) =>
        command.getOptionValueSource(option.attributeName()) === 'cli',
    )
    .map(optionName);
  const supplied = command.registeredArguments.slice(0, command.args.length);
  return flags.concat(supplied.map((argument) => `<${argument.name()}>`));
}

/** The long flag of an option, or its declaration when it has no long form. */
function optionName(option: Option): string {
  return option.long ?? option.flags;
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : '';
}
