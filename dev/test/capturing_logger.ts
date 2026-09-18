/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {LogLevel, Logger} from '@google/adk';

/**
 * Logger that keeps every message in memory, so a test can assert on what a
 * failure path reported instead of on console output.
 */
export class CapturingLogger implements Logger {
  readonly debugMessages: string[] = [];
  readonly infoMessages: string[] = [];
  readonly warnMessages: string[] = [];
  readonly errorMessages: string[] = [];

  log(level: LogLevel, ...args: unknown[]): void {
    this.messagesFor(level).push(args.join(' '));
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

  setLogLevel(): void {}

  private messagesFor(level: LogLevel): string[] {
    switch (level) {
      case LogLevel.DEBUG:
        return this.debugMessages;
      case LogLevel.INFO:
        return this.infoMessages;
      case LogLevel.WARN:
        return this.warnMessages;
      default:
        return this.errorMessages;
    }
  }
}
