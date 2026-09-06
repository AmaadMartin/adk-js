/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import {Console} from 'node:console';
import {Writable} from 'node:stream';
import {stripVTControlCharacters} from 'node:util';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';

import {LogLevel} from '@google/adk';
import {AdkLogger, AdkLoggerOptions} from '../../src/utils/logger.js';

/** The options `AdkApiServer` builds its logger with. */
const API_SERVER_OPTIONS: AdkLoggerOptions = {
  label: 'ADK API Server',
  timestamp: true,
  colorize: {level: true},
  printFormat: (info) =>
    `${info.level}: [${info.label}] ${info.timestamp} ${info.message}`,
};

/** The options the ADK CLI builds its logger with. */
const CLI_OPTIONS: AdkLoggerOptions = {
  label: 'ADK CLI',
  colorize: {all: true},
};

/**
 * A stream that keeps everything written to it. Winston's Console transport
 * writes to `console._stdout` / `console._stderr`, so a test reads a record by
 * giving `Console` streams that the test owns.
 */
class CaptureStream extends Writable {
  text = '';

  override _write(
    chunk: Buffer,
    _encoding: string,
    done: (error?: Error | null) => void,
  ): void {
    this.text += chunk.toString();
    done();
  }
}

const realConsole = globalThis.console;

describe('AdkLogger', () => {
  let stdout: CaptureStream;
  let stderr: CaptureStream;

  beforeEach(() => {
    stdout = new CaptureStream();
    stderr = new CaptureStream();
    globalThis.console = new Console(stdout, stderr);
  });

  afterEach(() => {
    globalThis.console = realConsole;
  });

  it('writes an error record to stderr', () => {
    new AdkLogger({label: 'test'}).error('boom');

    expect(stderr.text).toContain('boom');
    expect(stdout.text).toBe('');
  });

  it('writes a warning record to stderr', () => {
    new AdkLogger({label: 'test'}).warn('careful');

    expect(stderr.text).toContain('careful');
    expect(stdout.text).toBe('');
  });

  it('writes an info record to stdout', () => {
    new AdkLogger({label: 'test'}).info('hello');

    expect(stdout.text).toContain('hello');
    expect(stderr.text).toBe('');
  });

  it('writes a debug record to stdout', () => {
    const logger = new AdkLogger({label: 'test'});
    logger.setLogLevel(LogLevel.DEBUG);

    logger.debug('trace me');

    expect(stdout.text).toContain('trace me');
    expect(stderr.text).toBe('');
  });

  it('keeps the record layout on stderr', () => {
    new AdkLogger(API_SERVER_OPTIONS).error('kaboom');

    expect(stripVTControlCharacters(stderr.text)).toMatch(
      /^ERROR: \[ADK API Server\] .+ kaboom/,
    );
  });

  it('still suppresses a record below the log level', () => {
    const logger = new AdkLogger({label: 'test'});
    logger.setLogLevel(LogLevel.ERROR);

    logger.warn('quiet');

    expect(stderr.text).toBe('');
    expect(stdout.text).toBe('');

    logger.error('loud');

    expect(stderr.text).toContain('loud');
    expect(stdout.text).toBe('');
  });

  it('still suppresses debug and info at the default log level', () => {
    const logger = new AdkLogger({label: 'test'});

    logger.debug('too chatty');
    logger.setLogLevel(LogLevel.WARN);
    logger.info('also chatty');

    expect(stdout.text).toBe('');
    expect(stderr.text).toBe('');
  });

  it('routes a colorized CLI error to stderr', () => {
    new AdkLogger(CLI_OPTIONS).error('cli failure');

    expect(stderr.text).toContain('cli failure');
    expect(stdout.text).toBe('');
  });
});
