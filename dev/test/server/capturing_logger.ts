/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {LogLevel, type Logger} from '@google/adk';

/**
 * A {@link Logger} that keeps every message so a test can assert on it instead
 * of the message being printed.
 *
 * The `*Messages` arrays and the shorter `infos`/`warnings`/`errors` aliases
 * name the same backing arrays, so a test can read the capture under whichever
 * name it prefers.
 */
export class CapturingLogger implements Logger {
  readonly debugMessages: string[] = [];
  readonly infoMessages: string[] = [];
  readonly warnMessages: string[] = [];
  readonly errorMessages: string[] = [];
  readonly infos = this.infoMessages;
  readonly warnings = this.warnMessages;
  readonly errors = this.errorMessages;

  log(level: LogLevel, ...args: unknown[]): void {
    if (level === LogLevel.WARN) {
      this.warn(...args);
    } else if (level === LogLevel.ERROR) {
      this.error(...args);
    } else if (level === LogLevel.INFO) {
      this.info(...args);
    } else {
      this.debug(...args);
    }
  }

  debug(...args: unknown[]): void {
    this.debugMessages.push(args.join(' '));
  }

  info(...args: unknown[]): void {
    this.infoMessages.push(args.join(' '));
  }

  warn(...args: unknown[]): void {
    this.warnMessages.push(args.join(' '));
  }

  error(...args: unknown[]): void {
    this.errorMessages.push(args.join(' '));
  }

  setLogLevel(_level: LogLevel): void {}
}
