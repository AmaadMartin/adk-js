/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {
  CommandRun,
  MetricsCollector,
  TelemetryEnvironment,
} from '../../../src/cli/telemetry/metrics_collector.js';
import {version} from '../../../src/version.js';

interface QueuedEvent {
  event_time_ms: number;
  source_extension_json: string;
}

interface QueuedPayload {
  client_session_id: string;
  sequence_number: number;
  environment: TelemetryEnvironment;
  command_run: CommandRun;
}

const AN_HOUR_MS = 3_600_000;
const CLEAN_RUN: CommandRun = {
  command: 'create',
  subcommand: '',
  exit_code: 0,
  duration_ms: 812,
};

let root: string;
let queueFile: string;
let sessionsDir: string;
let originalIsTty: boolean;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'adk-metrics-'));
  queueFile = path.join(root, 'telemetry_queue.jsonl');
  sessionsDir = path.join(root, 'telemetry_sessions');
  originalIsTty = process.stdout.isTTY;
});

afterEach(() => {
  process.stdout.isTTY = originalIsTty;
  fs.rmSync(root, {recursive: true, force: true});
});

function collector(): MetricsCollector {
  return new MetricsCollector({queueFile, sessionsDir});
}

function readQueue(): QueuedPayload[] {
  return fs
    .readFileSync(queueFile, 'utf-8')
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => {
      const event = JSON.parse(line) as QueuedEvent;
      return JSON.parse(event.source_extension_json) as QueuedPayload;
    });
}

function sessionFile(pid: number = process.ppid): string {
  return path.join(sessionsDir, `${pid}.json`);
}

function writeSession(file: string, contents: unknown): void {
  fs.mkdirSync(sessionsDir, {recursive: true});
  fs.writeFileSync(
    file,
    typeof contents === 'string' ? contents : JSON.stringify(contents),
  );
}

describe('MetricsCollector.recordCommandRun', () => {
  it('appends one record carrying the command, exit code and duration', () => {
    collector().recordCommandRun({
      command: 'deploy',
      subcommand: 'cloud_run',
      exit_code: 3,
      duration_ms: 1234,
    });

    const records = readQueue();
    expect(records).toHaveLength(1);
    expect(records[0]?.command_run).toEqual({
      command: 'deploy',
      subcommand: 'cloud_run',
      exit_code: 3,
      duration_ms: 1234,
    });
  });

  it('stamps the record with the wall-clock time', () => {
    const before = Date.now();

    collector().recordCommandRun(CLEAN_RUN);

    const event = JSON.parse(
      fs.readFileSync(queueFile, 'utf-8').trim(),
    ) as QueuedEvent;
    expect(event.event_time_ms).toBeGreaterThanOrEqual(before);
  });

  it('describes the environment it ran in', () => {
    collector().recordCommandRun(CLEAN_RUN);

    expect(readQueue()[0]?.environment).toEqual({
      os_type: os.platform(),
      language: 'javascript',
      language_version: process.versions.node,
      adk_version: version,
      is_tty: process.stdout.isTTY === true,
    });
  });

  it('reports is_tty true when stdout is a terminal', () => {
    process.stdout.isTTY = true;

    collector().recordCommandRun(CLEAN_RUN);

    expect(readQueue()[0]?.environment.is_tty).toBe(true);
  });

  it('reports is_tty false when stdout is not a terminal', () => {
    process.stdout.isTTY = false;

    collector().recordCommandRun(CLEAN_RUN);

    expect(readQueue()[0]?.environment.is_tty).toBe(false);
  });

  it('records the flags and the exception name it was given', () => {
    collector().recordCommandRun({
      ...CLEAN_RUN,
      flags: ['--model', '<app_name>'],
      exception_type: 'RangeError',
    });

    expect(readQueue()[0]?.command_run).toMatchObject({
      flags: ['--model', '<app_name>'],
      exception_type: 'RangeError',
    });
  });

  it('omits flags and exception_type when they carry nothing', () => {
    collector().recordCommandRun({...CLEAN_RUN, flags: [], exception_type: ''});

    const record = readQueue()[0]?.command_run;
    expect(record).not.toHaveProperty('flags');
    expect(record).not.toHaveProperty('exception_type');
  });

  it('truncates the command and subcommand at 64 characters', () => {
    collector().recordCommandRun({
      ...CLEAN_RUN,
      command: 'c'.repeat(200),
      subcommand: 's'.repeat(200),
    });

    const record = readQueue()[0]?.command_run;
    expect(record?.command).toHaveLength(64);
    expect(record?.subcommand).toHaveLength(64);
  });

  it('truncates the exception name at 128 characters', () => {
    collector().recordCommandRun({
      ...CLEAN_RUN,
      exception_type: 'E'.repeat(200),
    });

    expect(readQueue()[0]?.command_run.exception_type).toHaveLength(128);
  });

  it('keeps at most 50 flags, each at most 64 characters', () => {
    collector().recordCommandRun({
      ...CLEAN_RUN,
      flags: Array.from({length: 60}, () => `--${'f'.repeat(200)}`),
    });

    const flags = readQueue()[0]?.command_run.flags;
    expect(flags).toHaveLength(50);
    expect(flags?.[0]).toHaveLength(64);
  });

  it('stops appending once the queue passes 1 MB', () => {
    fs.writeFileSync(queueFile, `${'x'.repeat(1_048_577)}\n`);
    const sizeBefore = fs.statSync(queueFile).size;

    expect(() => collector().recordCommandRun(CLEAN_RUN)).not.toThrow();

    expect(fs.statSync(queueFile).size).toBe(sizeBefore);
  });

  it('returns normally when neither the queue nor the sessions dir can be created', () => {
    const blocker = path.join(root, 'blocker');
    fs.writeFileSync(blocker, 'not a directory');
    const blocked = new MetricsCollector({
      queueFile: path.join(blocker, 'telemetry_queue.jsonl'),
      sessionsDir: path.join(blocker, 'telemetry_sessions'),
    });

    expect(() => blocked.recordCommandRun(CLEAN_RUN)).not.toThrow();

    expect(fs.existsSync(path.join(blocker, 'telemetry_queue.jsonl'))).toBe(
      false,
    );
  });
});

describe('MetricsCollector session state', () => {
  it('keeps one session id and increments the sequence number', () => {
    const shared = collector();
    shared.recordCommandRun(CLEAN_RUN);
    shared.recordCommandRun(CLEAN_RUN);

    const records = readQueue();
    expect(records[0]?.sequence_number).toBe(1);
    expect(records[1]?.sequence_number).toBe(2);
    expect(records[1]?.client_session_id).toBe(records[0]?.client_session_id);
  });

  it('resumes the session a previous invocation left on disk', () => {
    collector().recordCommandRun(CLEAN_RUN);

    collector().recordCommandRun(CLEAN_RUN);

    const records = readQueue();
    expect(records[1]?.sequence_number).toBe(2);
    expect(records[1]?.client_session_id).toBe(records[0]?.client_session_id);
  });

  it('starts a new session after an hour of quiet', () => {
    collector().recordCommandRun(CLEAN_RUN);
    const stale = JSON.parse(fs.readFileSync(sessionFile(), 'utf-8')) as Record<
      string,
      unknown
    >;
    writeSession(sessionFile(), {
      ...stale,
      last_activity: (Date.now() - AN_HOUR_MS - 1000) / 1000,
    });

    collector().recordCommandRun(CLEAN_RUN);

    const records = readQueue();
    expect(records[1]?.sequence_number).toBe(1);
    expect(records[1]?.client_session_id).not.toBe(
      records[0]?.client_session_id,
    );
  });

  it('does not continue a session recorded under a different parent PID', () => {
    writeSession(sessionFile(process.ppid + 1), {
      session_id: 'other-terminal',
      sequence_number: 41,
      last_activity: Date.now() / 1000,
    });

    collector().recordCommandRun(CLEAN_RUN);

    const record = readQueue()[0];
    expect(record?.sequence_number).toBe(1);
    expect(record?.client_session_id).not.toBe('other-terminal');
  });

  it('starts a new session when the session file has no session id', () => {
    writeSession(sessionFile(), {
      sequence_number: 41,
      last_activity: Date.now() / 1000,
    });

    collector().recordCommandRun(CLEAN_RUN);

    expect(readQueue()[0]?.sequence_number).toBe(1);
  });

  it('starts a new session when the session file holds invalid JSON', () => {
    writeSession(sessionFile(), 'not json at all');

    collector().recordCommandRun(CLEAN_RUN);

    expect(readQueue()[0]?.sequence_number).toBe(1);
  });

  it('starts at sequence 1 when the recorded sequence number is not a number', () => {
    writeSession(sessionFile(), {
      session_id: 'resumed',
      sequence_number: 'many',
      last_activity: Date.now() / 1000,
    });

    collector().recordCommandRun(CLEAN_RUN);

    const record = readQueue()[0];
    expect(record?.client_session_id).toBe('resumed');
    expect(record?.sequence_number).toBe(1);
  });

  it('gives two collectors over one directory independent counters', () => {
    const first = collector();
    const second = collector();

    first.recordCommandRun(CLEAN_RUN);
    second.recordCommandRun(CLEAN_RUN);
    first.recordCommandRun(CLEAN_RUN);

    const records = readQueue();
    expect(records.map((record) => record.sequence_number)).toEqual([1, 1, 2]);
    expect(records[1]?.client_session_id).not.toBe(
      records[0]?.client_session_id,
    );
    expect(records[2]?.client_session_id).toBe(records[0]?.client_session_id);
  });

  it('starts a new session when the recorded session id is empty', () => {
    writeSession(sessionFile(), {
      session_id: '',
      sequence_number: 5,
      last_activity: Date.now() / 1000,
    });

    collector().recordCommandRun(CLEAN_RUN);

    const record = readQueue()[0];
    expect(record?.client_session_id).not.toBe('');
    expect(record?.sequence_number).toBe(1);
  });

  it('prunes stale session files and stray temp files, keeping fresh ones', () => {
    const stale = path.join(sessionsDir, '999999.json');
    const stray = path.join(sessionsDir, '888888.json.1234.tmp');
    const fresh = path.join(sessionsDir, '777777.json');
    writeSession(stale, {
      session_id: 'stale',
      sequence_number: 1,
      last_activity: (Date.now() - AN_HOUR_MS - 1000) / 1000,
    });
    writeSession(stray, {session_id: 'half-written'});
    writeSession(fresh, {
      session_id: 'fresh',
      sequence_number: 1,
      last_activity: Date.now() / 1000,
    });

    collector().recordCommandRun(CLEAN_RUN);

    expect(fs.existsSync(stale)).toBe(false);
    expect(fs.existsSync(stray)).toBe(false);
    expect(fs.existsSync(fresh)).toBe(true);
  });

  it('survives a session entry it cannot remove', () => {
    fs.mkdirSync(path.join(sessionsDir, 'undeletable.json'), {
      recursive: true,
    });
    fs.mkdirSync(path.join(sessionsDir, 'undeletable.tmp'), {recursive: true});

    expect(() => collector().recordCommandRun(CLEAN_RUN)).not.toThrow();

    expect(readQueue()).toHaveLength(1);
  });
});
