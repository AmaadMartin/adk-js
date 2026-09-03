/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {randomUUID} from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {AdkLogger} from '../../utils/logger.js';
import {version} from '../../version.js';
import {QUEUE_FILE, TELEMETRY_SESSIONS_DIR} from './constants.js';
import {readJsonObject, removeQuietly} from './safe_fs.js';

const logger = new AdkLogger({label: 'ADK CLI', colorize: {all: true}});

/** An hour of quiet time marks the end of a logical work session. */
const SESSION_INACTIVITY_TIMEOUT_MS = 3_600_000;

/** Stop appending once the queue reaches 1 MB, so a haywire script cannot fill the disk. */
const MAX_QUEUE_SIZE_BYTES = 1_048_576;

/** Cap on a recorded command, subcommand or flag name. */
const MAX_STRING_LENGTH = 64;

/** Cap on a recorded exception name. */
const MAX_EXCEPTION_LENGTH = 128;

/** Cap on how many flag names one record carries. */
const MAX_FLAGS_COUNT = 50;

const MS_PER_SECOND = 1000;

/**
 * One recorded CLI invocation.
 *
 * The field names are the wire contract adk-python already writes, so they
 * stay snake_case even though the surrounding TypeScript is camelCase.
 */
export interface CommandRun {
  command: string;
  subcommand: string;
  exit_code: number;
  duration_ms: number;
  flags?: string[];
  exception_type?: string;
}

/** Environment block stamped on every record. */
export interface TelemetryEnvironment {
  os_type: string;
  language: string;
  language_version: string;
  adk_version: string;
  is_tty: boolean;
}

/** Where a collector keeps its state. Both default to the paths under `~/.adk`. */
export interface MetricsCollectorOptions {
  queueFile?: string;
  sessionsDir?: string;
}

interface SessionState {
  sessionId: string;
  sequenceNumber: number;
}

/**
 * Queues ADK CLI invocation records on local disk.
 *
 * Records are only appended; nothing here reads them back or sends them
 * anywhere. adk-python's reporter, which drains the same queue file, is not
 * ported.
 */
export class MetricsCollector {
  private readonly queueFile: string;
  private readonly sessionsDir: string;
  private readonly environment: TelemetryEnvironment;
  private readonly sessionId: string;
  private sequenceNumber: number;

  constructor(options: MetricsCollectorOptions = {}) {
    this.queueFile = options.queueFile ?? QUEUE_FILE;
    this.sessionsDir = options.sessionsDir ?? TELEMETRY_SESSIONS_DIR;

    const state = loadSessionState(this.sessionsDir);
    this.sessionId = state.sessionId;
    this.sequenceNumber = state.sequenceNumber;

    this.environment = {
      os_type: os.platform(),
      language: 'javascript',
      language_version: process.versions.node,
      adk_version: version,
      is_tty: process.stdout.isTTY === true,
    };
  }

  /** Appends one invocation record to the local queue. */
  recordCommandRun(run: CommandRun): void {
    this.sequenceNumber += 1;
    writeSessionState(this.sessionsDir, this.sessionId, this.sequenceNumber);

    const event = {
      event_time_ms: Date.now(),
      source_extension_json: JSON.stringify({
        client_session_id: this.sessionId,
        sequence_number: this.sequenceNumber,
        environment: this.environment,
        command_run: boundCommandRun(run),
      }),
    };

    try {
      const queued = fs.statSync(this.queueFile, {throwIfNoEntry: false});
      if ((queued?.size ?? 0) > MAX_QUEUE_SIZE_BYTES) {
        return;
      }
      fs.mkdirSync(path.dirname(this.queueFile), {recursive: true});
      fs.appendFileSync(this.queueFile, `${JSON.stringify(event)}\n`, 'utf-8');
    } catch (error: unknown) {
      logger.debug(`Failed to record metric: ${String(error)}`);
    }
  }
}

/** Applies the size caps that keep one record small, whatever the caller passed. */
function boundCommandRun(run: CommandRun): CommandRun {
  const bounded: CommandRun = {
    command: run.command.slice(0, MAX_STRING_LENGTH),
    subcommand: run.subcommand.slice(0, MAX_STRING_LENGTH),
    exit_code: run.exit_code,
    duration_ms: run.duration_ms,
  };
  if (run.flags !== undefined && run.flags.length > 0) {
    bounded.flags = run.flags
      .slice(0, MAX_FLAGS_COUNT)
      .map((flag) => flag.slice(0, MAX_STRING_LENGTH));
  }
  if (run.exception_type !== undefined && run.exception_type !== '') {
    bounded.exception_type = run.exception_type.slice(0, MAX_EXCEPTION_LENGTH);
  }
  return bounded;
}

function sessionFilePath(sessionsDir: string): string {
  return path.join(sessionsDir, `${process.ppid}.json`);
}

/**
 * `last_activity` is written in Unix seconds, the unit adk-python writes, so
 * both SDKs can share one session file on the same machine.
 */
function lastActivityMs(info: Record<string, unknown> | undefined): number {
  const value = info?.['last_activity'];
  return typeof value === 'number' ? value * MS_PER_SECOND : 0;
}

/** Resumes the session this terminal was already using, or starts a new one. */
function loadSessionState(sessionsDir: string): SessionState {
  const info = readJsonObject(sessionFilePath(sessionsDir));
  if (Date.now() - lastActivityMs(info) < SESSION_INACTIVITY_TIMEOUT_MS) {
    const sessionId = info?.['session_id'];
    if (typeof sessionId === 'string' && sessionId !== '') {
      const sequenceNumber = info?.['sequence_number'];
      return {
        sessionId,
        sequenceNumber: typeof sequenceNumber === 'number' ? sequenceNumber : 0,
      };
    }
  }
  return {sessionId: randomUUID(), sequenceNumber: 0};
}

/** Writes the session state through a temp file, so a crash cannot truncate it. */
function writeSessionState(
  sessionsDir: string,
  sessionId: string,
  sequenceNumber: number,
): void {
  pruneExpiredSessions(sessionsDir);

  const sessionFile = sessionFilePath(sessionsDir);
  const tempFile = `${sessionFile}.${process.pid}.tmp`;
  const info = {
    session_id: sessionId,
    sequence_number: sequenceNumber,
    last_activity: Date.now() / MS_PER_SECOND,
  };

  try {
    fs.mkdirSync(sessionsDir, {recursive: true});
    fs.writeFileSync(tempFile, JSON.stringify(info), 'utf-8');
    fs.renameSync(tempFile, sessionFile);
  } catch (error: unknown) {
    logger.debug(`Failed to write the telemetry session: ${String(error)}`);
    removeQuietly(tempFile);
  }
}

/** Drops session files older than the inactivity timeout, and any stray temp file. */
function pruneExpiredSessions(sessionsDir: string): void {
  let entries: string[];
  try {
    entries = fs.readdirSync(sessionsDir);
  } catch {
    return;
  }

  for (const entry of entries) {
    const target = path.join(sessionsDir, entry);
    if (entry.endsWith('.tmp')) {
      removeQuietly(target);
    } else if (
      entry.endsWith('.json') &&
      Date.now() - lastActivityMs(readJsonObject(target)) >
        SESSION_INACTIVITY_TIMEOUT_MS
    ) {
      removeQuietly(target);
    }
  }
}
