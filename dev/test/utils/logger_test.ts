/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import {Console} from 'node:console';
import {EOL} from 'node:os';
import {Writable} from 'node:stream';
import {stripVTControlCharacters} from 'node:util';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';

import {LogLevel} from '@google/adk';
import {AdkLogger, AdkLoggerOptions} from '../../src/utils/logger.js';

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

/**
 * Points `globalThis.console` at streams the test owns, and reads them back.
 * Which stream carries a warn or error record is a separate concern, so both
 * readers join the two.
 */
class ConsoleCapture {
  private readonly stdout = new CaptureStream();
  private readonly stderr = new CaptureStream();

  install(): void {
    globalThis.console = new Console(this.stdout, this.stderr);
  }

  restore(): void {
    globalThis.console = realConsole;
  }

  /** Everything written, ANSI escapes intact. */
  raw(): string {
    return this.stdout.text + this.stderr.text;
  }

  /** Everything written, with the ANSI escapes removed. */
  text(): string {
    return stripVTControlCharacters(this.raw());
  }
}

/** The default option shape: no colorize, no timestamp, default `printf`. */
const PLAIN_OPTIONS: AdkLoggerOptions = {label: 'test'};

/** The options the ADK CLI builds its logger with. */
const CLI_OPTIONS: AdkLoggerOptions = {
  label: 'ADK CLI',
  colorize: {all: true},
};

/** The `AdkApiServer` option shape, reduced to the rendered level tag. */
const LEVEL_TAG_OPTIONS: AdkLoggerOptions = {
  label: 'test',
  colorize: {level: true},
  printFormat: (info) => `${info.level}: ${info.message}`,
};

/** The full option shape `AdkApiServer` builds its logger with. */
const API_SERVER_OPTIONS: AdkLoggerOptions = {
  label: 'ADK API Server',
  timestamp: true,
  colorize: {level: true},
  printFormat: (info) =>
    `${info.level}: [${info.label}] ${info.timestamp} ${info.message}`,
};

const LEVEL_TAGS = [
  {level: LogLevel.DEBUG, tag: 'DEBUG'},
  {level: LogLevel.INFO, tag: 'INFO'},
  {level: LogLevel.WARN, tag: 'WARN'},
  {level: LogLevel.ERROR, tag: 'ERROR'},
];

/** Every level-named method, with the level its gate compares against. */
const LEVEL_METHODS = [
  {
    name: 'debug',
    level: LogLevel.DEBUG,
    emit: (logger: AdkLogger, message: string) => logger.debug(message),
  },
  {
    name: 'info',
    level: LogLevel.INFO,
    emit: (logger: AdkLogger, message: string) => logger.info(message),
  },
  {
    name: 'warn',
    level: LogLevel.WARN,
    emit: (logger: AdkLogger, message: string) => logger.warn(message),
  },
  {
    name: 'error',
    level: LogLevel.ERROR,
    emit: (logger: AdkLogger, message: string) => logger.error(message),
  },
];

let consoleOutput: ConsoleCapture;

beforeEach(() => {
  consoleOutput = new ConsoleCapture();
  consoleOutput.install();
});

afterEach(() => {
  consoleOutput.restore();
});

describe('AdkLogger.log', () => {
  it('emits a record with the colorizing CLI options', () => {
    const logger = new AdkLogger(CLI_OPTIONS);

    expect(() => {
      logger.log(LogLevel.ERROR, 'boom');
    }).not.toThrow();
    expect(consoleOutput.text()).toContain('boom');
  });

  it.each(LEVEL_TAGS)('logs at winston level $tag', ({level, tag}) => {
    const logger = new AdkLogger(LEVEL_TAG_OPTIONS);
    logger.setLogLevel(LogLevel.DEBUG);

    logger.log(level, 'msg');

    expect(consoleOutput.text()).toMatch(new RegExp(`^${tag}: msg$`, 'm'));
  });

  it('keeps the level gate', () => {
    const logger = new AdkLogger(LEVEL_TAG_OPTIONS);
    logger.setLogLevel(LogLevel.ERROR);

    logger.log(LogLevel.WARN, 'quiet');

    expect(consoleOutput.text()).toBe('');

    logger.log(LogLevel.ERROR, 'loud');

    expect(consoleOutput.text()).toContain('loud');
  });
});

describe('AdkLogger level methods', () => {
  it('emits an info record at the default level', () => {
    new AdkLogger(PLAIN_OPTIONS).info('hello');

    expect(consoleOutput.text()).toBe(`hello${EOL}`);
  });

  it('drops a debug record at the default level', () => {
    new AdkLogger(PLAIN_OPTIONS).debug('chatty');

    expect(consoleOutput.text()).toBe('');
  });

  it.each(LEVEL_METHODS)('$name emits at its own level', ({level, emit}) => {
    const logger = new AdkLogger(PLAIN_OPTIONS);
    logger.setLogLevel(level);

    emit(logger, 'msg');

    expect(consoleOutput.text()).toBe(`msg${EOL}`);
  });

  it.each(LEVEL_METHODS)(
    '$name is silent one level above its own',
    ({level, emit}) => {
      const logger = new AdkLogger(PLAIN_OPTIONS);
      // `LogLevel.ERROR` is the highest member, so silencing `error()` needs a
      // level the enum does not name.
      logger.setLogLevel(level + 1);

      emit(logger, 'msg');

      expect(consoleOutput.text()).toBe('');
    },
  );

  it('joins the arguments with a single space', () => {
    new AdkLogger(PLAIN_OPTIONS).info('a', 1, true);

    expect(consoleOutput.text()).toBe(`a 1 true${EOL}`);
  });
});

describe('AdkLogger constructor options', () => {
  it('prints the bare message by default', () => {
    new AdkLogger(PLAIN_OPTIONS).info('hello');

    expect(consoleOutput.raw()).toBe(`hello${EOL}`);
  });

  it('colors the level tag with colorize.level', () => {
    new AdkLogger(LEVEL_TAG_OPTIONS).warn('level colored');

    expect(consoleOutput.raw()).toContain('\u001b[');
    expect(consoleOutput.text()).toBe(`WARN: level colored${EOL}`);
  });

  it('folds the label into the message with colorize.all', () => {
    new AdkLogger(CLI_OPTIONS).info('cli message');

    expect(consoleOutput.text()).toBe(`[ADK CLI] cli message${EOL}`);
  });

  it('renders the level, label and timestamp for the API server', () => {
    new AdkLogger(API_SERVER_OPTIONS).error('kaboom');

    expect(consoleOutput.text()).toMatch(
      /^ERROR: \[ADK API Server\] \d{4}-\d{2}-\d{2}T[\d:.]+Z kaboom$/m,
    );
  });
});
