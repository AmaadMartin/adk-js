/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Command} from 'commander';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {createProgram} from '../../src/cli/cli.js';
import {
  CommandRun,
  elapsedMs,
  getQueueFilePath,
  recordCommandRun,
  resolveCommandPath,
  toErrorName,
} from '../../src/cli/cli_metrics.js';
import {installCommandMetrics} from '../../src/cli/cli_telemetry.js';
import {writeTelemetryConsent} from '../../src/utils/telemetry_config.js';

interface QueuedEvent {
  event_time_ms: number;
  source_extension_json: string;
}

interface QueuedCommandRun {
  command: string;
  subcommand: string;
  exit_code: number;
  duration_ms: number;
  exception_type?: string;
}

const CLEAN_RUN: CommandRun = {
  command: 'web',
  subcommand: '',
  exitCode: 0,
  durationMs: 12,
  exceptionType: '',
};

const {fakeHome} = vi.hoisted(() => ({fakeHome: {path: ''}}));

vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>();
  return {...actual, homedir: () => fakeHome.path};
});

/** Reads the queued records, newest last. */
function readQueue(): QueuedCommandRun[] {
  const contents = fs.readFileSync(getQueueFilePath(), 'utf-8');
  return contents
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => {
      const event = JSON.parse(line) as QueuedEvent;
      const payload = JSON.parse(event.source_extension_json) as {
        command_run: QueuedCommandRun;
      };
      return payload.command_run;
    });
}

beforeEach(() => {
  fakeHome.path = fs.mkdtempSync(path.join(os.tmpdir(), 'adk-metrics-'));
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(fakeHome.path, {recursive: true, force: true});
});

describe('recordCommandRun', () => {
  it('appends one record per invocation', () => {
    recordCommandRun(CLEAN_RUN);
    recordCommandRun({...CLEAN_RUN, command: 'run', exitCode: 3});

    expect(readQueue()).toEqual([
      {command: 'web', subcommand: '', exit_code: 0, duration_ms: 12},
      {command: 'run', subcommand: '', exit_code: 3, duration_ms: 12},
    ]);
  });

  it('stamps the record with the wall-clock time', () => {
    const before = Date.now();

    recordCommandRun(CLEAN_RUN);

    const event = JSON.parse(
      fs.readFileSync(getQueueFilePath(), 'utf-8').trim(),
    ) as QueuedEvent;
    expect(event.event_time_ms).toBeGreaterThanOrEqual(before);
  });

  it('adds exception_type only when the run ended with an error', () => {
    recordCommandRun({...CLEAN_RUN, exitCode: 1, exceptionType: 'TypeError'});

    expect(readQueue()[0]?.exception_type).toBe('TypeError');
  });

  it('truncates the command and subcommand at 64 characters', () => {
    recordCommandRun({
      ...CLEAN_RUN,
      command: 'c'.repeat(100),
      subcommand: 's'.repeat(100),
    });

    const record = readQueue()[0];
    expect(record?.command).toHaveLength(64);
    expect(record?.subcommand).toHaveLength(64);
  });

  it('truncates the exception name at 128 characters', () => {
    recordCommandRun({...CLEAN_RUN, exceptionType: 'E'.repeat(200)});

    expect(readQueue()[0]?.exception_type).toHaveLength(128);
  });

  it('stops appending once the queue passes 1 MB', () => {
    const queueFile = getQueueFilePath();
    fs.mkdirSync(path.dirname(queueFile), {recursive: true});
    fs.writeFileSync(queueFile, `${'x'.repeat(1_048_577)}\n`);
    const sizeBefore = fs.statSync(queueFile).size;

    recordCommandRun(CLEAN_RUN);

    expect(fs.statSync(queueFile).size).toBe(sizeBefore);
  });

  it('swallows a write failure instead of breaking the command', () => {
    // A file where the .adk directory belongs makes every write fail.
    fs.writeFileSync(path.join(fakeHome.path, '.adk'), 'not a directory');

    expect(() => recordCommandRun(CLEAN_RUN)).not.toThrow();
  });
});

describe('resolveCommandPath', () => {
  const program = createProgram();

  it('resolves a top-level command, leaving the subcommand empty', () => {
    expect(resolveCommandPath(['web', './agents'], program)).toEqual([
      'web',
      '',
    ]);
  });

  it('resolves a command and its subcommand', () => {
    expect(resolveCommandPath(['deploy', 'cloud_run', '.'], program)).toEqual([
      'deploy',
      'cloud_run',
    ]);
  });

  it('skips a flag written before the command', () => {
    expect(
      resolveCommandPath(['--log_level', 'DEBUG', 'web'], program),
    ).toEqual(['web', '']);
  });

  it('returns empty names when no command matches', () => {
    expect(resolveCommandPath(['--version'], program)).toEqual(['', '']);
  });

  it('does not record an argument that names another top-level command', () => {
    // 'create' is a command of the program, but not of 'web', so here it is
    // the agents directory and must not be recorded as a subcommand.
    expect(resolveCommandPath(['web', 'create'], program)).toEqual(['web', '']);
  });
});

describe('toErrorName', () => {
  it('names a built-in error', () => {
    expect(toErrorName(new TypeError('bad'))).toBe('TypeError');
  });

  it('names a custom error that sets its own name', () => {
    const error = new Error('nope');
    error.name = 'AgentLoadError';

    expect(toErrorName(error)).toBe('AgentLoadError');
  });

  it('falls back to the type of a thrown non-error', () => {
    expect(toErrorName('a string')).toBe('string');
  });
});

describe('elapsedMs', () => {
  it('measures forward from an hrtime reading', () => {
    expect(elapsedMs(process.hrtime.bigint())).toBeGreaterThanOrEqual(0);
  });
});

describe('installCommandMetrics', () => {
  let program: Command;
  let installed = process.listeners('exit');

  /** Installs the metrics, capturing the exit listener it registers. */
  const install = (argv: string[]): void => {
    const before = process.listeners('exit');
    installCommandMetrics(program, argv);
    installed = process
      .listeners('exit')
      .filter((listener) => !before.includes(listener));
  };

  beforeEach(() => {
    program = createProgram();
    installed = [];
  });

  afterEach(() => {
    for (const listener of installed) {
      process.off('exit', listener);
    }
    process.removeAllListeners('uncaughtExceptionMonitor');
  });

  it('records the command, the exit code and a duration once the run ends', () => {
    writeTelemetryConsent(true);

    install(['web', './agents']);
    expect(installed).toHaveLength(1);
    installed[0]?.(0);

    const record = readQueue()[0];
    expect(record?.command).toBe('web');
    expect(record?.subcommand).toBe('');
    expect(record?.exit_code).toBe(0);
    expect(record?.duration_ms).toBeGreaterThanOrEqual(0);
    expect(record?.exception_type).toBeUndefined();
  });

  it('records the subcommand of a command group', () => {
    writeTelemetryConsent(true);

    install(['deploy', 'cloud_run', '.']);
    installed[0]?.(0);

    expect(readQueue()[0]?.subcommand).toBe('cloud_run');
  });

  it('records the exit code a command chose', () => {
    writeTelemetryConsent(true);

    install(['run', 'agent.ts']);
    installed[0]?.(3);

    expect(readQueue()[0]?.exit_code).toBe(3);
  });

  it('records the name of an error that crashed the run', () => {
    writeTelemetryConsent(true);

    install(['run', 'agent.ts']);
    process.emit('uncaughtExceptionMonitor', new RangeError('boom'));
    installed[0]?.(1);

    const record = readQueue()[0];
    expect(record?.exit_code).toBe(1);
    expect(record?.exception_type).toBe('RangeError');
  });

  it('records nothing when no consent is stored', () => {
    install(['web', './agents']);

    expect(installed).toHaveLength(0);
    expect(fs.existsSync(getQueueFilePath())).toBe(false);
  });

  it('records nothing when the user opted out', () => {
    writeTelemetryConsent(false);

    install(['web', './agents']);

    expect(installed).toHaveLength(0);
    expect(fs.existsSync(getQueueFilePath())).toBe(false);
  });

  it('records nothing for a help request', () => {
    writeTelemetryConsent(true);

    install(['web', '--help']);

    expect(installed).toHaveLength(0);
  });

  it('records nothing for the telemetry group itself', () => {
    writeTelemetryConsent(true);

    install(['telemetry', 'status']);

    expect(installed).toHaveLength(0);
  });

  it('records nothing when no command was named', () => {
    writeTelemetryConsent(true);

    install(['--version']);

    expect(installed).toHaveLength(0);
  });
});
