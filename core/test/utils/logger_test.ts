/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  getLogger,
  logger,
  Logger,
  LogLevel,
  setLogger,
  setLogLevel,
} from '@google/adk';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {resetLogger} from '../../src/utils/logger.js';

/** Builds a logger that appends each call it receives to `sink`. */
function recordingLogger(sink: string[]): Logger {
  return {
    setLogLevel: (level) => sink.push(`setLogLevel:${LogLevel[level]}`),
    log: (level, ...args) => sink.push(`log:${LogLevel[level]}:${args[0]}`),
    debug: (...args) => sink.push(`debug:${args[0]}`),
    info: (...args) => sink.push(`info:${args[0]}`),
    warn: (...args) => sink.push(`warn:${args[0]}`),
    error: (...args) => sink.push(`error:${args[0]}`),
  };
}

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

describe('logger (public export)', () => {
  beforeEach(() => {
    resetLogger();
    setLogLevel(LogLevel.DEBUG);
  });

  afterEach(() => {
    resetLogger();
  });

  it('is reachable from the package entry point', () => {
    expect(logger).toBeDefined();
    for (const method of [
      'log',
      'debug',
      'info',
      'warn',
      'error',
      'setLogLevel',
    ] as const) {
      expect(typeof logger[method]).toBe('function');
    }
  });

  it('routes to a logger installed after the reference was taken', () => {
    const sink: string[] = [];

    setLogger(recordingLogger(sink));
    logger.warn('late bound');

    expect(sink).toEqual(['warn:late bound']);
  });

  it('forwards every level', () => {
    const sink: string[] = [];
    setLogger(recordingLogger(sink));

    logger.debug('d');
    logger.info('i');
    logger.warn('w');
    logger.error('e');
    logger.log(LogLevel.INFO, 'l');

    expect(sink).toEqual([
      'debug:d',
      'info:i',
      'warn:w',
      'error:e',
      'log:INFO:l',
    ]);
  });

  it('forwards setLogLevel', () => {
    const sink: string[] = [];
    setLogger(recordingLogger(sink));

    logger.setLogLevel(LogLevel.ERROR);

    expect(sink).toEqual(['setLogLevel:ERROR']);
  });

  it('goes silent when logging is disabled after the reference was taken', () => {
    const sink: string[] = [];
    setLogger(recordingLogger(sink));
    setLogger(null);

    expect(() => logger.warn('dropped')).not.toThrow();
    expect(sink).toEqual([]);
  });

  it('follows setLogger where a cached getLogger() result does not', () => {
    const first: string[] = [];
    const second: string[] = [];
    setLogger(recordingLogger(first));
    const cached = getLogger();
    setLogger(recordingLogger(second));

    cached.warn('stale');
    logger.warn('fresh');

    expect(first).toEqual(['warn:stale']);
    expect(second).toEqual(['warn:fresh']);
  });

  it('reaches a spy installed on the getLogger() instance', () => {
    const warnSpy = vi.spyOn(getLogger(), 'warn').mockImplementation(() => {});

    logger.warn('spied');

    expect(warnSpy).toHaveBeenCalledWith('spied');
    warnSpy.mockRestore();
  });
});
