/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {LogLevel, Logger} from '@google/adk';
import * as winston from 'winston';

/**
 * Options for the ADK CLI logger.
 */
export interface AdkLoggerOptions {
  label: string;
  colorize?: {
    level?: boolean;
    all?: boolean;
    message?: boolean;
    colors?: {
      [level: string]: string;
    };
  };
  timestamp?: boolean;
  printFormat?: (info: {
    message: unknown;
    label?: string;
    level?: string;
    timestamp?: string;
  }) => string;
}

/**
 * Level for every {@link AdkLogger} that was not given one of its own. Module
 * loggers are constructed at import time, before the CLI has parsed
 * `--verbose` / `--log_level`, so the level is read per call rather than
 * captured in the constructor.
 */
let defaultLogLevel = LogLevel.INFO;

/** Sets the level for AdkLoggers with no explicit level of their own. */
export function setDefaultLogLevel(level: LogLevel): void {
  defaultLogLevel = level;
}

/**
 * Logger implementation for the ADK CLI.
 */
export class AdkLogger implements Logger {
  private readonly logger: winston.Logger;
  private logLevel?: LogLevel;

  private get level(): LogLevel {
    return this.logLevel ?? defaultLogLevel;
  }

  constructor(options: AdkLoggerOptions) {
    const formats = [
      winston.format.label({
        label: options.label,
        message: options.colorize?.all,
      }),
      winston.format((info) => {
        info.level = info.level.toUpperCase();
        return info;
      })(),
    ];

    if (options.colorize) {
      formats.push(winston.format.colorize(options.colorize));
    }
    if (options.timestamp) {
      formats.push(winston.format.timestamp());
    }
    if (options.printFormat) {
      formats.push(winston.format.printf(options.printFormat));
    } else {
      formats.push(winston.format.printf((info) => info.message as string));
    }

    this.logger = winston.createLogger({
      levels: {
        'debug': LogLevel.DEBUG,
        'info': LogLevel.INFO,
        'warn': LogLevel.WARN,
        'error': LogLevel.ERROR,
      },
      level: 'error',
      format: winston.format.combine(...formats),
      transports: [new winston.transports.Console()],
    });
  }

  setLogLevel(level: LogLevel) {
    this.logLevel = level;
  }

  log(level: LogLevel, ...messages: unknown[]): void {
    if (this.level > level) {
      return;
    }

    this.logger.log(level.toString(), messages.join(' '));
  }

  debug(...messages: unknown[]): void {
    if (this.level > LogLevel.DEBUG) {
      return;
    }

    this.logger.debug(messages.join(' '));
  }

  info(...messages: unknown[]): void {
    if (this.level > LogLevel.INFO) {
      return;
    }

    this.logger.info(messages.join(' '));
  }

  warn(...messages: unknown[]): void {
    if (this.level > LogLevel.WARN) {
      return;
    }

    this.logger.warn(messages.join(' '));
  }

  error(...messages: unknown[]): void {
    if (this.level > LogLevel.ERROR) {
      return;
    }

    this.logger.error(messages.join(' '));
  }
}
