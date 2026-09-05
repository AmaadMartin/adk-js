/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {getLogger, LogLevel, setLogger, type Logger} from '@google/adk';

/** A logger that keeps the warnings it is given instead of printing them. */
class RecordingLogger implements Logger {
  readonly warnings: string[] = [];

  setLogLevel(): void {}

  log(level: LogLevel, ...args: unknown[]): void {
    if (level === LogLevel.WARN) {
      this.warn(...args);
    }
  }

  debug(): void {}

  info(): void {}

  warn(...args: unknown[]): void {
    this.warnings.push(args.join(' '));
  }

  error(): void {}
}

/**
 * Runs `body` with a logger that records its warnings, and returns both the
 * body's value and the warnings it logged.
 *
 * The test suite runs at the `ERROR` level, so a warning is otherwise
 * discarded before any spy can see it.
 */
export function recordWarnings<T>(body: () => T): {
  result: T;
  warnings: string[];
} {
  const previousLogger = getLogger();
  const recordingLogger = new RecordingLogger();
  setLogger(recordingLogger);
  try {
    return {result: body(), warnings: recordingLogger.warnings};
  } finally {
    setLogger(previousLogger);
  }
}
