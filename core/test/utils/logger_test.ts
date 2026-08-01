/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  getLogger,
  getLogLevel,
  Logger,
  LogLevel,
  setLogger,
  setLogLevel,
} from '@google/adk';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {logger as loggerFacade, resetLogger} from '../../src/utils/logger.js';

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

const LEVEL_CASES = [
  LogLevel.DEBUG,
  LogLevel.INFO,
  LogLevel.WARN,
  LogLevel.ERROR,
].map((level) => ({name: LogLevel[level], level}));

describe('getLogLevel', () => {
  beforeEach(() => {
    resetLogger();
  });

  afterEach(() => {
    resetLogger();
  });

  describe('default logger', () => {
    it('returns INFO for the default logger', () => {
      expect(getLogLevel()).toBe(LogLevel.INFO);
    });

    it.each(LEVEL_CASES)('reflects setLogLevel($name)', ({level}) => {
      setLogLevel(level);

      expect(getLogLevel()).toBe(level);
    });
  });

  describe('custom logger that implements getLogLevel', () => {
    it('returns the level reported by the custom logger', () => {
      const customLogger: Logger = {
        setLogLevel: () => {},
        log: () => {},
        debug: () => {},
        info: () => {},
        warn: () => {},
        error: () => {},
        getLogLevel: () => LogLevel.WARN,
      };

      setLogger(customLogger);

      expect(getLogLevel()).toBe(LogLevel.WARN);
    });

    it('delegates on every call instead of caching a copy', () => {
      let level = LogLevel.INFO;
      const customLogger: Logger = {
        setLogLevel: (next) => {
          level = next;
        },
        log: () => {},
        debug: () => {},
        info: () => {},
        warn: () => {},
        error: () => {},
        getLogLevel: () => level,
      };

      setLogger(customLogger);
      setLogLevel(LogLevel.ERROR);

      expect(getLogLevel()).toBe(LogLevel.ERROR);
    });
  });

  describe('custom logger that does not implement getLogLevel', () => {
    const customLogger: Logger = {
      setLogLevel: () => {},
      log: () => {},
      debug: () => {},
      info: () => {},
      warn: () => {},
      error: () => {},
    };

    it('returns undefined', () => {
      setLogger(customLogger);

      expect(getLogLevel()).toBeUndefined();
    });

    it('does not throw', () => {
      setLogger(customLogger);

      expect(() => getLogLevel()).not.toThrow();
    });
  });

  describe('null logger', () => {
    it('returns undefined for the no-op logger', () => {
      setLogger(null);

      expect(getLogLevel()).toBeUndefined();
    });

    it('returns INFO again after resetLogger', () => {
      setLogger(null);
      resetLogger();

      expect(getLogLevel()).toBe(LogLevel.INFO);
    });
  });

  describe('logger facade', () => {
    it('forwards to the active logger', () => {
      setLogLevel(LogLevel.WARN);

      expect(loggerFacade.getLogLevel?.()).toBe(LogLevel.WARN);
    });

    it('reports undefined when the active logger has no level', () => {
      setLogger(null);

      expect(loggerFacade.getLogLevel?.()).toBeUndefined();
    });
  });
});
