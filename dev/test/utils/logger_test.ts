/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {LogLevel, setLogLevel} from '@google/adk';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import type {LoggerOptions} from 'winston';
import {AdkLogger} from '../../src/utils/logger.js';

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
    emits: METHOD_LEVELS[method] >= threshold,
  })),
);

/** Runs the most recently created logger's format chain over one info object. */
function render(level: string, message: string): string {
  const format = createdConfigs.at(-1)?.format;
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

describe('AdkLogger', () => {
  beforeEach(() => {
    emitted.length = 0;
    createdConfigs.length = 0;
  });

  afterEach(() => {
    setLogLevel(LogLevel.INFO);
  });

  it.each(GATING_MATRIX)(
    'pinned to $thresholdName: $method() emits=$emits',
    ({threshold, method, emits}) => {
      const logger = new AdkLogger({label: 'Test'});
      logger.setLogLevel(threshold);

      logger[method]('gated message');

      expect(emitted).toEqual(
        emits ? [{level: method, message: 'gated message'}] : [],
      );
    },
  );

  it('still shapes the winston format from its constructor options', () => {
    new AdkLogger({
      label: 'ADK CLI',
      colorize: {all: true},
      timestamp: true,
      printFormat: (info) => `${info.level}|${info.timestamp}|${info.message}`,
    });

    const [level, timestamp, message] = render('info', 'hello').split('|');

    expect(level).toContain('INFO');
    expect(timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(message).toContain('[ADK CLI] hello');
  });

  it('renders the raw message when no printFormat is given', () => {
    new AdkLogger({label: 'ADK CLI'});

    expect(render('info', 'plain')).toBe('plain');
  });

  describe('process-wide default level', () => {
    it('is muted and unmuted by setLogLevel from @google/adk', () => {
      const logger = new AdkLogger({label: 'Test'});

      setLogLevel(LogLevel.ERROR);
      logger.info('suppressed');
      logger.error('emitted at error');

      expect(emitted).toEqual([{level: 'error', message: 'emitted at error'}]);

      setLogLevel(LogLevel.DEBUG);
      logger.debug('emitted at debug');

      expect(emitted).toEqual([
        {level: 'error', message: 'emitted at error'},
        {level: 'debug', message: 'emitted at debug'},
      ]);
    });
  });
});
