/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Command} from 'commander';
import {EventEmitter} from 'node:events';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {instrumentCommandMetrics} from '../../../src/cli/telemetry/command_metrics.js';
import {
  CommandRun,
  MetricsCollector,
} from '../../../src/cli/telemetry/metrics_collector.js';

interface QueuedEvent {
  source_extension_json: string;
}

interface QueuedPayload {
  command_run: CommandRun;
}

let root: string;
let queueFile: string;
let sessionsDir: string;
let events: EventEmitter;
let dispose: () => void;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'adk-command-metrics-'));
  queueFile = path.join(root, 'telemetry_queue.jsonl');
  sessionsDir = path.join(root, 'telemetry_sessions');
  events = new EventEmitter();
  dispose = () => {};
});

afterEach(() => {
  dispose();
  fs.rmSync(root, {recursive: true, force: true});
});

/**
 * A throwaway program shaped like the real CLI: a `create` command with
 * options and a positional, a `deploy` group, a `web` command that binds `-h`
 * to `--host`, and the `telemetry` group.
 */
function buildProgram(): Command {
  const program = new Command();
  program.name('adk').exitOverride().option('--log_level <level>', 'log level');

  program
    .command('create')
    .argument('<app_name>', 'the app to create')
    .argument('[template]', 'an optional template')
    .option('--model <model>', 'the model to use')
    .option('--api_key <key>', 'the API key')
    .option('--region <region>', 'the region', 'us-central1')
    .option('-q', 'quiet')
    .action(() => {});

  const deploy = program.command('deploy');
  deploy
    .command('cloud_run')
    .argument('<agent>', 'the agent to deploy')
    .option('--with_ui', 'ship the developer UI')
    .action(() => {});

  program
    .command('web')
    .option('-h, --host <host>', 'the host to bind', '127.0.0.1')
    .action(() => {});

  program
    .command('telemetry')
    .command('status')
    .action(() => {});

  return program;
}

interface RunOptions {
  readConsent?: () => boolean | undefined;
  collector?: MetricsCollector;
  now?: () => number;
  exitCode?: number;
  throwName?: string;
}

/** Instruments a fresh program and returns it, ready to parse. */
function instrument(argv: string[], options: RunOptions = {}): Command {
  const program = buildProgram();
  dispose = instrumentCommandMetrics(program, argv, {
    readConsent: options.readConsent ?? (() => true),
    collector:
      options.collector ?? new MetricsCollector({queueFile, sessionsDir}),
    now: options.now,
    events,
  });
  return program;
}

/** Instruments a fresh program, parses `argv`, then emits the process exit. */
function run(argv: string[], options: RunOptions = {}): void {
  instrument(argv, options).parse(argv, {from: 'user'});
  if (options.throwName !== undefined) {
    const error = new Error('boom');
    error.name = options.throwName;
    events.emit('uncaughtExceptionMonitor', error);
  }
  events.emit('exit', options.exitCode ?? 0);
}

function readQueue(): CommandRun[] {
  return fs
    .readFileSync(queueFile, 'utf-8')
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => {
      const event = JSON.parse(line) as QueuedEvent;
      return (JSON.parse(event.source_extension_json) as QueuedPayload)
        .command_run;
    });
}

function onlyRecord(): CommandRun {
  const records = readQueue();
  expect(records).toHaveLength(1);
  const record = records[0];
  if (record === undefined) {
    expect.fail('the queue holds no record');
  }
  return record;
}

describe('instrumentCommandMetrics', () => {
  it('records the flag names and the positional placeholder, never a value', () => {
    run(['create', '--model', 'gemini-2.0', '--api_key', 'dummy', 'my_app']);

    const record = onlyRecord();
    expect(record.command).toBe('create');
    expect(record.subcommand).toBe('');
    expect(record.flags).toEqual(['--model', '--api_key', '<app_name>']);

    const written = fs.readFileSync(queueFile, 'utf-8');
    expect(written).not.toContain('gemini-2.0');
    expect(written).not.toContain('dummy');
    expect(written).not.toContain('my_app');
  });

  it('records only the positional arguments the user supplied', () => {
    run(['create', 'my_app']);

    expect(onlyRecord().flags).toEqual(['<app_name>']);
  });

  it('records an option that has no long form under its short flag', () => {
    run(['create', '-q', 'my_app']);

    expect(onlyRecord().flags).toEqual(['-q', '<app_name>']);
  });

  it('leaves an option at its default out of the flags', () => {
    run(['create', 'my_app']);

    expect(onlyRecord().flags).not.toContain('--region');
  });

  it('resolves a group and its subcommand', () => {
    run(['deploy', 'cloud_run', './agent', '--with_ui']);

    const record = onlyRecord();
    expect(record.command).toBe('deploy');
    expect(record.subcommand).toBe('cloud_run');
    expect(record.flags).toEqual(['--with_ui', '<agent>']);
  });

  it('skips a flag written before the command', () => {
    run(['--log_level', 'DEBUG', 'create', 'my_app']);

    expect(onlyRecord().command).toBe('create');
  });

  it('records nothing when no argument names a command', () => {
    instrument(['--log_level', 'DEBUG']);
    events.emit('exit', 0);

    expect(events.eventNames()).toEqual([]);
    expect(fs.existsSync(queueFile)).toBe(false);
  });

  it('records nothing for a help request', () => {
    instrument(['create', '--help']);
    events.emit('exit', 0);

    expect(events.eventNames()).toEqual([]);
    expect(fs.existsSync(queueFile)).toBe(false);
  });

  it('still records when -h means --host', () => {
    run(['web', '-h', '0.0.0.0']);

    const record = onlyRecord();
    expect(record.command).toBe('web');
    expect(record.flags).toEqual(['--host']);
  });

  it('records nothing for the telemetry group', () => {
    run(['telemetry', 'status']);

    expect(fs.existsSync(queueFile)).toBe(false);
  });

  it('creates no file and no directory when the user opted out', () => {
    run(['create', 'my_app'], {readConsent: () => false});

    expect(fs.existsSync(queueFile)).toBe(false);
    expect(fs.existsSync(sessionsDir)).toBe(false);
  });

  it('creates no file and no directory when no preference is recorded', () => {
    run(['create', 'my_app'], {readConsent: () => undefined});

    expect(fs.existsSync(queueFile)).toBe(false);
    expect(fs.existsSync(sessionsDir)).toBe(false);
  });

  it('registers no listener when the user opted out', () => {
    instrument(['create', 'my_app'], {readConsent: () => false});

    expect(events.eventNames()).toEqual([]);
  });

  it('records the exit code a command set', () => {
    run(['create', 'my_app'], {exitCode: 2});

    expect(onlyRecord().exit_code).toBe(2);
  });

  it('records the name of an error that crashed the process', () => {
    run(['create', 'my_app'], {throwName: 'RangeError', exitCode: 1});

    const record = onlyRecord();
    expect(record.exit_code).toBe(1);
    expect(record.exception_type).toBe('RangeError');
  });

  it('records no exception type when the thrown value is not an error', () => {
    const program = buildProgram();
    dispose = instrumentCommandMetrics(program, ['create', 'my_app'], {
      readConsent: () => true,
      collector: new MetricsCollector({queueFile, sessionsDir}),
      events,
    });
    program.parse(['create', 'my_app'], {from: 'user'});

    events.emit('uncaughtExceptionMonitor', 'a bare string');
    events.emit('exit', 1);

    expect(onlyRecord()).not.toHaveProperty('exception_type');
  });

  it('measures the duration from the injected clock', () => {
    const readings = [1000, 1812];

    run(['create', 'my_app'], {now: () => readings.shift() ?? 1812});

    expect(onlyRecord().duration_ms).toBe(812);
  });

  it('leaves the exit code untouched when the collector throws', () => {
    const broken = new MetricsCollector({queueFile, sessionsDir});
    broken.recordCommandRun = () => {
      throw new Error('recorder is broken');
    };

    expect(() =>
      run(['create', 'my_app'], {collector: broken, exitCode: 7}),
    ).not.toThrow();

    expect(fs.existsSync(queueFile)).toBe(false);
  });

  it('removes its listeners when disposed', () => {
    const program = buildProgram();

    const stop = instrumentCommandMetrics(program, ['create', 'my_app'], {
      readConsent: () => true,
      collector: new MetricsCollector({queueFile, sessionsDir}),
      events,
    });
    stop();
    events.emit('exit', 0);

    expect(events.eventNames()).toEqual([]);
    expect(fs.existsSync(queueFile)).toBe(false);
  });

  it('measures a real elapsed duration when no clock is injected', () => {
    run(['create', 'my_app']);

    expect(onlyRecord().duration_ms).toBeGreaterThanOrEqual(0);
  });
});

describe('instrumentCommandMetrics with no dependency overrides', () => {
  let home: string;
  let previousHome: string | undefined;
  let previousUserProfile: string | undefined;

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'adk-home-'));
    previousHome = process.env['HOME'];
    previousUserProfile = process.env['USERPROFILE'];
    // os.homedir() reads HOME on POSIX and USERPROFILE on Windows.
    process.env['HOME'] = home;
    process.env['USERPROFILE'] = home;
    fs.mkdirSync(path.join(home, '.adk'));
    vi.resetModules();
  });

  afterEach(() => {
    process.env['HOME'] = previousHome;
    process.env['USERPROFILE'] = previousUserProfile;
    fs.rmSync(home, {recursive: true, force: true});
  });

  it('reads the consent and writes the queue under ~/.adk', async () => {
    fs.writeFileSync(
      path.join(home, '.adk', 'config.json'),
      JSON.stringify({telemetry: true}),
    );
    const module =
      await import('../../../src/cli/telemetry/command_metrics.js');
    const program = buildProgram();

    const stop = module.instrumentCommandMetrics(program, [
      'create',
      '--model',
      'gemini-2.0',
      'my_app',
    ]);
    program.parse(['create', '--model', 'gemini-2.0', 'my_app'], {
      from: 'user',
    });
    process.emit('exit', 0);
    stop();

    const queued = fs
      .readFileSync(path.join(home, '.adk', 'telemetry_queue.jsonl'), 'utf-8')
      .trim();
    const event = JSON.parse(queued) as QueuedEvent;
    const payload = JSON.parse(event.source_extension_json) as QueuedPayload;
    expect(payload.command_run).toMatchObject({
      command: 'create',
      exit_code: 0,
      flags: ['--model', '<app_name>'],
    });
    expect(fs.existsSync(path.join(home, '.adk', 'telemetry_sessions'))).toBe(
      true,
    );
  });

  it('writes nothing under ~/.adk when the user never opted in', async () => {
    const module =
      await import('../../../src/cli/telemetry/command_metrics.js');
    const program = buildProgram();

    const stop = module.instrumentCommandMetrics(program, ['create', 'my_app']);
    program.parse(['create', 'my_app'], {from: 'user'});
    process.emit('exit', 0);
    stop();

    expect(fs.readdirSync(path.join(home, '.adk'))).toEqual([]);
  });
});
