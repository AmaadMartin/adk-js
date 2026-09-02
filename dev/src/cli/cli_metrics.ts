/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Command} from 'commander';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {AdkLogger} from '../utils/logger.js';
import {isRecord, toMessage} from '../utils/value_utils.js';

const logger = new AdkLogger({label: 'ADK CLI', colorize: {all: true}});

/** Stop appending once the queue reaches this size, to bound disk use. */
const MAX_QUEUE_SIZE_BYTES = 1_048_576;
/** Cap on a recorded command or subcommand name. */
const MAX_STRING_LENGTH = 64;
/** Cap on a recorded exception name. */
const MAX_EXCEPTION_LENGTH = 128;

const NANOSECONDS_PER_MILLISECOND = 1_000_000n;

/** One finished `adk` invocation. */
export interface CommandRun {
  /** The top-level command, or '' when none was resolved. */
  command: string;
  /** The subcommand, or '' when the command has none. */
  subcommand: string;
  exitCode: number;
  durationMs: number;
  /** The name of the error that ended the run, or '' on a clean run. */
  exceptionType: string;
}

/**
 * Returns the path of the local telemetry queue.
 *
 * The location and the file name match adk-python, so a machine with both
 * SDKs installed shares one queue and one reporter drains it.
 */
export function getQueueFilePath(): string {
  return path.join(os.homedir(), '.adk', 'telemetry_queue.jsonl');
}

/**
 * Appends one invocation record to the local telemetry queue.
 *
 * The record carries the `command_run` fields only. adk-python also sends a
 * client session id, a sequence number and an environment fingerprint; those
 * belong to its `_telemetry` module, which adk-js has not ported.
 *
 * Nothing here may break the CLI, so every failure is swallowed. This mirrors
 * adk-python's bare `except Exception: pass` around the same write, and is the
 * one place in the CLI where a broad catch is correct: the user asked for a
 * command, not for telemetry.
 */
export function recordCommandRun(run: CommandRun): void {
  try {
    const queueFile = getQueueFilePath();
    if (
      fs.existsSync(queueFile) &&
      fs.statSync(queueFile).size > MAX_QUEUE_SIZE_BYTES
    ) {
      return;
    }

    const commandRun: Record<string, unknown> = {
      command: run.command.slice(0, MAX_STRING_LENGTH),
      subcommand: run.subcommand.slice(0, MAX_STRING_LENGTH),
      exit_code: run.exitCode,
      duration_ms: run.durationMs,
    };
    if (run.exceptionType !== '') {
      commandRun['exception_type'] = run.exceptionType.slice(
        0,
        MAX_EXCEPTION_LENGTH,
      );
    }

    fs.mkdirSync(path.dirname(queueFile), {recursive: true});
    fs.appendFileSync(
      queueFile,
      `${JSON.stringify({
        event_time_ms: Date.now(),
        source_extension_json: JSON.stringify({command_run: commandRun}),
      })}\n`,
      {encoding: 'utf-8'},
    );
  } catch (error: unknown) {
    logger.debug(`Failed to record a CLI metric: ${toMessage(error)}`);
  }
}

/**
 * Resolves which command the arguments select, as a `[command, subcommand]`
 * pair. Anything that is not a command name is skipped, so a flag written
 * before the command does not hide it.
 */
export function resolveCommandPath(
  argv: readonly string[],
  program: Command,
): [string, string] {
  const resolved: string[] = [];
  let current = program;
  for (const arg of argv) {
    const next = current.commands.find((command) => command.name() === arg);
    if (next === undefined) {
      continue;
    }
    resolved.push(arg);
    current = next;
  }
  return [resolved[0] ?? '', resolved[1] ?? ''];
}

/** Names the error that ended a run, the way a stack trace names it. */
export function toErrorName(error: unknown): string {
  if (isRecord(error) && typeof error['name'] === 'string') {
    return error['name'];
  }
  return typeof error;
}

/** Milliseconds elapsed since a `process.hrtime.bigint()` reading. */
export function elapsedMs(startedAt: bigint): number {
  return Number(
    (process.hrtime.bigint() - startedAt) / NANOSECONDS_PER_MILLISECOND,
  );
}
