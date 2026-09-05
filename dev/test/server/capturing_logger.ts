/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {LogLevel, type Logger} from '@google/adk';

/**
 * A {@link Logger} that keeps what it is given instead of printing it, so a
 * test can assert on a report the code under test makes instead of throwing.
 */
export class CapturingLogger implements Logger {
  readonly infos: string[] = [];
  readonly warnings: string[] = [];
  readonly errors: string[] = [];

  setLogLevel(): void {}

  log(level: LogLevel, ...args: unknown[]): void {
    if (level === LogLevel.INFO) {
      this.info(...args);
    } else if (level === LogLevel.WARN) {
      this.warn(...args);
    } else if (level === LogLevel.ERROR) {
      this.error(...args);
    }
  }

  debug(): void {}

  info(...args: unknown[]): void {
    this.infos.push(args.join(' '));
  }

  warn(...args: unknown[]): void {
    this.warnings.push(args.join(' '));
  }

  error(...args: unknown[]): void {
    this.errors.push(args.join(' '));
  }
}
