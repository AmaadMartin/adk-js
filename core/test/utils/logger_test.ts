/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {getLogger, Logger, LogLevel, setLogger, setLogLevel} from '@google/adk';
import {Console} from 'node:console';
import {Writable} from 'node:stream';
import {stripVTControlCharacters} from 'node:util';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {resetLogger} from '../../src/utils/logger.js';

describe('setLogger', () => {
  beforeEach(() => {
    resetLogger();
    setLogLevel(LogLevel.DEBUG);
  });

  afterEach(() => {
    resetLogger();
  });

  describe('custom logger', () => {
    it('routes log messages to custom logger', () => {
      const messages: Array<{level: string; args: unknown[]}> = [];
      const customLogger: Logger = {
        setLogLevel: () => {},
        log: (level, ...args) => messages.push({level: LogLevel[level], args}),
        debug: (...args) => messages.push({level: 'DEBUG', args}),
        info: (...args) => messages.push({level: 'INFO', args}),
        warn: (...args) => messages.push({level: 'WARN', args}),
        error: (...args) => messages.push({level: 'ERROR', args}),
      };

      setLogger(customLogger);
      const logger = getLogger();

      logger.info('test message', 123);

      expect(messages).toHaveLength(1);
      expect(messages[0].level).toBe('INFO');
      expect(messages[0].args).toEqual(['test message', 123]);
    });

    it('calls correct method for each log level', () => {
      const calls: string[] = [];
      const customLogger: Logger = {
        setLogLevel: () => calls.push('setLogLevel'),
        log: () => calls.push('log'),
        debug: () => calls.push('debug'),
        info: () => calls.push('info'),
        warn: () => calls.push('warn'),
        error: () => calls.push('error'),
      };

      setLogger(customLogger);
      const logger = getLogger();

      logger.debug('debug');
      logger.info('info');
      logger.warn('warn');
      logger.error('error');

      expect(calls).toEqual(['debug', 'info', 'warn', 'error']);
    });
  });

  describe('null logger (disable logging)', () => {
    it('disables all logging when null is passed', () => {
      setLogger(null);
      const logger = getLogger();

      expect(logger.constructor.name).toBe('NoOpLogger');
    });

    it('handles all log levels silently', () => {
      setLogger(null);
      const logger = getLogger();

      expect(() => {
        logger.debug('debug');
        logger.info('info');
        logger.warn('warn');
        logger.error('error');
        logger.log(LogLevel.INFO, 'log');
      }).not.toThrow();
    });
  });

  describe('backward compatibility', () => {
    it('deprecated logger export still works with custom logger', async () => {
      const {logger} = await import('../../src/utils/logger.js');

      const messages: string[] = [];
      const customLogger: Logger = {
        setLogLevel: () => {},
        log: () => {},
        debug: () => {},
        info: (...args) => messages.push(String(args[0])),
        warn: () => {},
        error: () => {},
      };

      setLogger(customLogger);

      logger.info('backward compatible');

      expect(messages).toContain('backward compatible');
    });
  });

  describe('getLogger', () => {
    it('returns the current logger instance', () => {
      const customLogger: Logger = {
        setLogLevel: () => {},
        log: () => {},
        debug: () => {},
        info: () => {},
        warn: () => {},
        error: () => {},
      };

      setLogger(customLogger);

      const logger = getLogger();
      expect(logger).toBeDefined();
    });

    it('returns default logger initially', () => {
      const logger = getLogger();
      expect(logger).toBeDefined();
      expect(typeof logger.info).toBe('function');
    });
  });

  describe('resetLogger', () => {
    it('restores the default logger', () => {
      setLogger(null);
      resetLogger();

      const logger = getLogger();

      expect(logger.constructor.name).toBe('SimpleLogger');
    });
  });
});

/**
 * A stream that keeps everything written to it. Winston's Console transport
 * writes straight to `console._stdout` / `console._stderr`, so a test reads a
 * record by giving `Console` streams that the test owns.
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

/** Lets the winston pipeline deliver the record to its transport. */
function flush(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

describe('SimpleLogger console transport', () => {
  const realConsole = globalThis.console;
  let stdout: CaptureStream;
  let stderr: CaptureStream;

  beforeEach(() => {
    stdout = new CaptureStream();
    stderr = new CaptureStream();
    globalThis.console = new Console(stdout, stderr);
    resetLogger();
  });

  afterEach(() => {
    globalThis.console = realConsole;
    resetLogger();
  });

  it('writes an error record to stderr', async () => {
    getLogger().error('boom');
    await flush();

    expect(stderr.text).toContain('boom');
    expect(stdout.text).toBe('');
  });

  it('writes a warning record to stderr', async () => {
    getLogger().warn('careful');
    await flush();

    expect(stderr.text).toContain('careful');
    expect(stdout.text).toBe('');
  });

  it('writes an info record to stdout', async () => {
    getLogger().info('hello');
    await flush();

    expect(stdout.text).toContain('hello');
    expect(stderr.text).toBe('');
  });

  it('writes a debug record to stdout', async () => {
    setLogLevel(LogLevel.DEBUG);

    getLogger().debug('trace me');
    await flush();

    expect(stdout.text).toContain('trace me');
    expect(stderr.text).toBe('');
  });

  it('keeps the upper-cased level token on the stderr record', async () => {
    getLogger().error('boom');
    await flush();

    expect(stripVTControlCharacters(stderr.text)).toMatch(
      /^ERROR: \[ADK\] .+ boom/,
    );
  });

  it('still suppresses a record below the log level', async () => {
    setLogLevel(LogLevel.ERROR);

    getLogger().warn('quiet');
    await flush();

    expect(stderr.text).toBe('');
    expect(stdout.text).toBe('');

    getLogger().error('loud');
    await flush();

    expect(stderr.text).toContain('loud');
    expect(stdout.text).toBe('');
  });
});
