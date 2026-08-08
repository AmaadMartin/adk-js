/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  formatLogArgs,
  getLogger,
  Logger,
  LogLevel,
  setLogger,
  setLogLevel,
} from '@google/adk';
import {Console} from 'node:console';
import {Writable} from 'node:stream';
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
 * writes straight to `console._stdout`, so a test reads a record by giving
 * `Console` streams that the test owns.
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

describe('SimpleLogger output formatting', () => {
  const realConsole = globalThis.console;
  let stdout: CaptureStream;

  beforeEach(() => {
    stdout = new CaptureStream();
    globalThis.console = new Console(stdout, new CaptureStream());
    resetLogger();
    setLogLevel(LogLevel.DEBUG);
  });

  afterEach(() => {
    globalThis.console = realConsole;
    resetLogger();
  });

  it('logs the stack of an Error', () => {
    getLogger().error(new Error('boom'));

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

    getLogger().error(new NamedError('sub-boom'));

    expect(stdout.text).toContain('NamedError: sub-boom');
    expect(stdout.text).toContain('at ');
  });

  it('logs the contents of a plain object', () => {
    getLogger().error({a: 1});

    expect(stdout.text).toContain('{ a: 1 }');
    expect(stdout.text).not.toContain('[object Object]');
  });

  it('logs a string unchanged', () => {
    getLogger().error('plain message');

    expect(stdout.text).toContain('plain message');
  });

  it('logs undefined as the word undefined', () => {
    getLogger().error(undefined);

    expect(stdout.text).toContain('undefined');
  });

  it('formats the argument on the debug, info and warn methods', () => {
    const logger = getLogger();

    logger.debug({level: 'debug'});
    logger.info({level: 'info'});
    logger.warn({level: 'warn'});

    expect(stdout.text).toContain("{ level: 'debug' }");
    expect(stdout.text).toContain("{ level: 'info' }");
    expect(stdout.text).toContain("{ level: 'warn' }");
    expect(stdout.text).not.toContain('[object Object]');
  });

  it('joins a prefix and an Error with a single space', () => {
    getLogger().error('Error during startup:', new Error('boom'));

    expect(stdout.text).toContain('Error during startup: Error: boom');
    expect(stdout.text).toContain('at ');
  });
});

describe('formatLogArgs', () => {
  it('renders an Error as its stack trace', () => {
    const formatted = formatLogArgs([new Error('boom')]);
    expect(formatted).toContain('Error: boom');
    expect(formatted).toContain('at ');
  });

  it('renders a subclassed Error under its own name', () => {
    class NamedError extends Error {
      constructor(message: string) {
        super(message);
        this.name = 'NamedError';
      }
    }
    const formatted = formatLogArgs([new NamedError('sub-boom')]);
    expect(formatted.startsWith('NamedError: ')).toBe(true);
    expect(formatted).toContain('at ');
  });

  it('falls back to the message when an Error carries no stack', () => {
    const err = new Error('nostack');
    err.stack = undefined;
    expect(formatLogArgs([err])).toBe('Error: nostack');
  });

  it('inspects a plain object instead of coercing it to a string', () => {
    const formatted = formatLogArgs([{a: 1, b: 'two'}]);
    expect(formatted).toBe("{ a: 1, b: 'two' }");
    expect(formatted).not.toContain('[object Object]');
  });

  it('renders a value nested four levels deep', () => {
    const formatted = formatLogArgs([{l1: {l2: {l3: {l4: 'innermost'}}}}]);
    expect(formatted).toContain('innermost');
    expect(formatted).not.toContain('[Object]');
  });

  it('renders a self-referential object without throwing', () => {
    const cyclic: Record<string, unknown> = {a: 1};
    cyclic['self'] = cyclic;
    expect(formatLogArgs([cyclic])).toContain('[Circular');
  });

  it('passes a string through unchanged', () => {
    expect(formatLogArgs(['plain'])).toBe('plain');
  });

  it('renders undefined as the word undefined', () => {
    expect(formatLogArgs([undefined])).toBe('undefined');
  });

  it('renders null as the word null', () => {
    expect(formatLogArgs([null])).toBe('null');
  });

  it('renders a number', () => {
    expect(formatLogArgs([42])).toBe('42');
  });

  it('renders an array', () => {
    const formatted = formatLogArgs([[1, 'a']]);
    expect(formatted).toContain('1');
    expect(formatted).toContain("'a'");
  });

  it('joins several arguments with a single space', () => {
    expect(formatLogArgs(['prefix:', 42, undefined])).toBe(
      'prefix: 42 undefined',
    );
  });

  it('returns an empty string for no arguments', () => {
    expect(formatLogArgs([])).toBe('');
  });
});
