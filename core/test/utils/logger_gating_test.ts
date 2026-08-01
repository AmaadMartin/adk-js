/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {LogLevel, setLogLevel, WinstonLogger} from '@google/adk';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import type {LoggerOptions} from 'winston';
import {resetLogger} from '../../src/utils/logger.js';

const {createdConfigs, emitted} = vi.hoisted(() => ({
  createdConfigs: [] as LoggerOptions[],
  emitted: [] as Array<{level: string; message: string}>,
}));

vi.mock('winston', async (importOriginal) => {
  const actual = await importOriginal<typeof import('winston')>();
  const record = (level: string) => (message: string) => {
    emitted.push({level, message});
  };
  return {
    ...actual,
    createLogger: (config: LoggerOptions) => {
      createdConfigs.push(config);
      return {
        log: (level: string, message: string) => {
          emitted.push({level, message});
        },
        debug: record('debug'),
        info: record('info'),
        warn: record('warn'),
        error: record('error'),
      };
    },
  };
});

/**
 * `triple-beam`'s `LEVEL` and `MESSAGE`, which are global registered symbols.
 * They are read directly rather than imported because `triple-beam` is a
 * transitive winston dependency, not a declared one.
 */
const LEVEL_SYMBOL = Symbol.for('level');
const MESSAGE_SYMBOL = Symbol.for('message');

type LevelMethod = 'debug' | 'info' | 'warn' | 'error';

const METHOD_LEVELS: Record<LevelMethod, LogLevel> = {
  debug: LogLevel.DEBUG,
  info: LogLevel.INFO,
  warn: LogLevel.WARN,
  error: LogLevel.ERROR,
};

const ALL_LEVELS: LogLevel[] = [
  LogLevel.DEBUG,
  LogLevel.INFO,
  LogLevel.WARN,
  LogLevel.ERROR,
];

const LEVEL_METHODS = Object.keys(METHOD_LEVELS) as LevelMethod[];

/** Every (threshold, level) pair, with whether that level should be emitted. */
const GATING_MATRIX = ALL_LEVELS.flatMap((threshold) =>
  LEVEL_METHODS.map((method) => ({
    thresholdName: LogLevel[threshold],
    threshold,
    method,
    levelName: LogLevel[METHOD_LEVELS[method]],
    level: METHOD_LEVELS[method],
    emits: METHOD_LEVELS[method] >= threshold,
  })),
);

function lastConfig(): LoggerOptions {
  const config = createdConfigs.at(-1);
  if (!config) {
    expect.fail('winston.createLogger was never called');
  }
  return config;
}

/** Runs the most recently created logger's format chain over one info object. */
function render(level: string, message: string): string {
  const format = lastConfig().format;
  if (!format) {
    expect.fail('winston.createLogger was called without a format');
  }
  const transformed = format.transform(
    {level, message, [LEVEL_SYMBOL]: level},
    {},
  );
  if (typeof transformed === 'boolean') {
    expect.fail('the format chain dropped the info object');
  }
  return String(transformed[MESSAGE_SYMBOL]);
}

function createTestLogger(): WinstonLogger {
  return new WinstonLogger({label: 'Test'});
}

describe('WinstonLogger', () => {
  beforeEach(() => {
    emitted.length = 0;
    createdConfigs.length = 0;
  });

  afterEach(() => {
    setLogLevel(LogLevel.INFO);
    resetLogger();
  });

  describe('level gating', () => {
    it.each(GATING_MATRIX)(
      'pinned to $thresholdName: $method() emits=$emits',
      ({threshold, method, emits}) => {
        const logger = createTestLogger();
        logger.setLogLevel(threshold);

        logger[method]('gated message');

        expect(emitted).toEqual(
          emits ? [{level: method, message: 'gated message'}] : [],
        );
      },
    );

    it.each(GATING_MATRIX)(
      'pinned to $thresholdName: log($levelName) emits=$emits',
      ({threshold, level, levelName, emits}) => {
        const logger = createTestLogger();
        logger.setLogLevel(threshold);

        logger.log(level, 'gated message');

        expect(emitted).toEqual(
          emits
            ? [{level: levelName.toLowerCase(), message: 'gated message'}]
            : [],
        );
      },
    );

    it('defaults to INFO when the instance was never pinned', () => {
      const logger = createTestLogger();

      logger.debug('suppressed');
      logger.info('emitted');

      expect(emitted).toEqual([{level: 'info', message: 'emitted'}]);
    });
  });

  describe('log()', () => {
    it('logs at the winston level name, not the numeric enum value', () => {
      const logger = createTestLogger();

      logger.log(LogLevel.INFO, 'named');

      expect(emitted).toEqual([{level: 'info', message: 'named'}]);
    });

    it('joins multiple messages with a space', () => {
      const logger = createTestLogger();

      logger.info('a', 1);

      expect(emitted).toEqual([{level: 'info', message: 'a 1'}]);
    });
  });

  describe('process-wide default level', () => {
    it('reaches an instance that was constructed before the call', () => {
      const logger = createTestLogger();

      setLogLevel(LogLevel.ERROR);
      logger.info('suppressed');
      logger.error('emitted');

      expect(emitted).toEqual([{level: 'error', message: 'emitted'}]);
    });

    it('loses to an explicit instance pin', () => {
      const logger = createTestLogger();
      logger.setLogLevel(LogLevel.DEBUG);

      setLogLevel(LogLevel.ERROR);
      logger.debug('emitted');

      expect(emitted).toEqual([{level: 'debug', message: 'emitted'}]);
    });
  });

  describe('winston construction', () => {
    it('inverts the winston levels map so gating is left to LogLevel', () => {
      createTestLogger();

      expect(lastConfig().levels).toEqual({
        debug: LogLevel.DEBUG,
        info: LogLevel.INFO,
        warn: LogLevel.WARN,
        error: LogLevel.ERROR,
      });
      expect(lastConfig().level).toBe('error');
    });

    it('feeds label, uppercased level and a timestamp to printFormat', () => {
      new WinstonLogger({
        label: 'L',
        colorize: {level: true},
        timestamp: true,
        printFormat: (info) =>
          `${info.level}|${info.label}|${info.timestamp}|${info.message}`,
      });

      const [level, label, timestamp, message] = render('info', 'hello').split(
        '|',
      );

      expect(level).toContain('INFO');
      expect(label).toBe('L');
      expect(timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      expect(message).toBe('hello');
    });

    it('omits the timestamp when the option is off', () => {
      new WinstonLogger({
        label: 'L',
        timestamp: false,
        printFormat: (info) => `timestamp=${info.timestamp}`,
      });

      expect(render('info', 'hello')).toBe('timestamp=undefined');
    });

    it('renders the raw message when no printFormat is given', () => {
      new WinstonLogger({label: 'L'});

      expect(render('info', 'plain')).toBe('plain');
    });
  });

  describe('SimpleLogger', () => {
    it('renders the level, label, timestamp and message as before', () => {
      resetLogger();

      expect(render('info', 'hello world')).toMatch(
        /^\S*INFO\S*: \[ADK\] \S+ hello world$/,
      );
    });
  });
});
