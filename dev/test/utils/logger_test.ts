/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {LogLevel} from '@google/adk';
import {Console} from 'node:console';
import {EOL} from 'node:os';
import {Writable} from 'node:stream';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {
  AdkLogger,
  AdkLoggerOptions,
  setDefaultLogLevel,
} from '../../src/utils/logger.js';

/**
 * A stream that keeps everything written to it. Winston's Console transport
 * writes straight to `console._stdout`, so a test reads a record by giving
 * `Console` streams that the test owns. The transport terminates a record with
 * `os.EOL`, so an exact assertion has to spell that out.
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

/** The options `AdkApiServer` builds its logger with. */
const API_SERVER_OPTIONS: AdkLoggerOptions = {
  label: 'ADK API Server',
  timestamp: true,
  colorize: {level: true},
  printFormat: (info) =>
    `${info.level}: [${info.label}] ${info.timestamp} ${info.message}`,
};

describe('AdkLogger output formatting', () => {
  const realConsole = globalThis.console;
  let stdout: CaptureStream;
  let logger: AdkLogger;

  beforeEach(() => {
    stdout = new CaptureStream();
    globalThis.console = new Console(stdout, new CaptureStream());
    logger = new AdkLogger({label: 'Test'});
    logger.setLogLevel(LogLevel.DEBUG);
  });

  afterEach(() => {
    globalThis.console = realConsole;
  });

  it('logs the stack of an Error', () => {
    logger.error(new Error('boom'));

    expect(stdout.text).toContain('Error: boom');
    expect(stdout.text).toContain('at ');
  });

  it('logs the stack of a subclassed Error under its own name', () => {
    class NamedError extends Error {
      constructor(message: string) {
        super(message);
        this.name = 'NamedError';
      }
    }

    logger.error(new NamedError('sub-boom'));

    expect(stdout.text).toContain('NamedError: sub-boom');
    expect(stdout.text).toContain('at ');
  });

  it('logs the contents of a plain object', () => {
    logger.error({a: 1});

    expect(stdout.text).toBe(`{ a: 1 }${EOL}`);
  });

  it('logs a string unchanged', () => {
    logger.error('plain message');

    expect(stdout.text).toBe(`plain message${EOL}`);
  });

  it('logs undefined as the word undefined', () => {
    logger.error(undefined);

    expect(stdout.text).toBe(`undefined${EOL}`);
  });

  it('formats the argument on the debug, info and warn methods', () => {
    logger.debug({level: 'debug'});
    logger.info({level: 'info'});
    logger.warn({level: 'warn'});

    expect(stdout.text).toBe(
      `{ level: 'debug' }${EOL}{ level: 'info' }${EOL}{ level: 'warn' }${EOL}`,
    );
  });

  it('joins a prefix and an Error with a single space', () => {
    logger.error('Error during startup:', new Error('boom'));

    expect(stdout.text).toContain('Error during startup: Error: boom');
    expect(stdout.text).toContain('at ');
  });

  it('logs the stack of an Error under the API server options', () => {
    const apiServerLogger = new AdkLogger(API_SERVER_OPTIONS);
    apiServerLogger.setLogLevel(LogLevel.DEBUG);

    apiServerLogger.error(new Error('boom'));

    expect(stdout.text).toContain('[ADK API Server]');
    expect(stdout.text).toContain('Error: boom');
    expect(stdout.text).toContain('at ');
  });
});

/**
 * `printFormat` is the observation point: winston runs the format pipeline
 * only for a record {@link AdkLogger} did not filter out, so an entry in
 * `messages` means the level gate let the record through.
 */
function createLogger(messages: unknown[]): AdkLogger {
  return new AdkLogger({
    label: 'test',
    printFormat: (info) => {
      messages.push(info.message);
      return '';
    },
  });
}

describe('AdkLogger', () => {
  afterEach(() => {
    setDefaultLogLevel(LogLevel.INFO);
  });

  describe('default level', () => {
    it('drops a debug record at the initial default', () => {
      const messages: unknown[] = [];
      const logger = createLogger(messages);

      logger.debug('hidden');

      expect(messages).toEqual([]);
    });

    it('emits a debug record once the default is DEBUG', async () => {
      const messages: unknown[] = [];
      const logger = createLogger(messages);

      setDefaultLogLevel(LogLevel.DEBUG);
      logger.debug('shown');

      await vi.waitFor(() => expect(messages).toContain('shown'));
    });

    it('applies to a logger built before the default changed', async () => {
      const messages: unknown[] = [];
      // Module loggers are constructed at import time, before the CLI parses
      // its flags, so the level cannot be captured in the constructor.
      const logger = createLogger(messages);

      setDefaultLogLevel(LogLevel.DEBUG);
      logger.debug('late');

      await vi.waitFor(() => expect(messages).toContain('late'));
    });
  });

  describe('explicit level', () => {
    it('wins over a more permissive default', () => {
      const messages: unknown[] = [];
      const logger = createLogger(messages);

      logger.setLogLevel(LogLevel.ERROR);
      setDefaultLogLevel(LogLevel.DEBUG);
      logger.debug('hidden');

      expect(messages).toEqual([]);
    });

    it('wins over a more restrictive default', async () => {
      const messages: unknown[] = [];
      const logger = createLogger(messages);

      logger.setLogLevel(LogLevel.DEBUG);
      setDefaultLogLevel(LogLevel.ERROR);
      logger.debug('shown');

      await vi.waitFor(() => expect(messages).toContain('shown'));
    });
  });
});
