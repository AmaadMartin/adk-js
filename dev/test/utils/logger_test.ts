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

const LEVEL_TAGS = [
  {level: LogLevel.DEBUG, tag: 'DEBUG'},
  {level: LogLevel.INFO, tag: 'INFO'},
  {level: LogLevel.WARN, tag: 'WARN'},
  {level: LogLevel.ERROR, tag: 'ERROR'},
];

describe('AdkLogger.log', () => {
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

  /**
   * Read both streams. Which stream carries a warn or error record is a
   * separate concern, so these tests assert on record content only.
   */
  function captured(): string {
    return stripVTControlCharacters(stdout.text + stderr.text);
  }

  it('emits a record with the colorizing CLI options', () => {
    const logger = new AdkLogger(CLI_OPTIONS);

    expect(() => {
      logger.log(LogLevel.ERROR, 'boom');
    }).not.toThrow();
    expect(captured()).toContain('boom');
  });

  it.each(LEVEL_TAGS)('logs at winston level $tag', ({level, tag}) => {
    const logger = new AdkLogger(LEVEL_TAG_OPTIONS);
    logger.setLogLevel(LogLevel.DEBUG);

    logger.log(level, 'msg');

    expect(captured()).toMatch(new RegExp(`^${tag}: msg$`, 'm'));
  });

  it('keeps the level gate', () => {
    const logger = new AdkLogger(LEVEL_TAG_OPTIONS);
    logger.setLogLevel(LogLevel.ERROR);

    logger.log(LogLevel.WARN, 'quiet');

    expect(captured()).toBe('');

    logger.log(LogLevel.ERROR, 'loud');

    expect(captured()).toContain('loud');
  });
});
