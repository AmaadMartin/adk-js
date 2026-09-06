/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {getLogger, LogLevel, setLogger, type Logger} from '@google/adk';

/** Every line the code under test logged, and the switch that restores ADK's logger. */
export interface CapturedLogs {
  readonly lines: string[];
  /** The captured lines joined, for a single "does not contain" assertion. */
  text(): string;
  restore(): void;
}

/**
 * Redirects ADK logging into a buffer for the duration of a test.
 *
 * Uses the shipped `setLogger` seam rather than a spy, so it captures whatever
 * the module under test holds a reference to.
 */
export function captureLogs(): CapturedLogs {
  const previous = getLogger();
  const lines: string[] = [];
  const record = (...args: unknown[]) => {
    lines.push(args.map((arg) => String(arg)).join(' '));
  };
  const capturing: Logger = {
    setLogLevel() {},
    log(_level: LogLevel, ...args: unknown[]) {
      record(...args);
    },
    debug: record,
    info: record,
    warn: record,
    error: record,
  };
  setLogger(capturing);
  return {
    lines,
    text: () => lines.join('\n'),
    restore: () => setLogger(previous),
  };
}
