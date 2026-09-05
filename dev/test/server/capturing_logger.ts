/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Logger, LogLevel} from '@google/adk';

/** A {@link Logger} that keeps every message so a test can assert on it. */
export class CapturingLogger implements Logger {
  readonly debugMessages: string[] = [];
  readonly infoMessages: string[] = [];
  readonly warnMessages: string[] = [];
  readonly errorMessages: string[] = [];

  log(_level: LogLevel, ...args: unknown[]): void {
    this.debugMessages.push(args.join(' '));
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
