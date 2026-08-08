/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import {inspect} from 'node:util';
import * as winston from 'winston';

/** Log levels for the logger. */
export enum LogLevel {
  DEBUG = 0,
  INFO = 1,
  WARN = 2,
  ERROR = 3,
}

/**
 * Logger interface for ADK.
 */
export interface Logger {
  log(level: LogLevel, ...args: unknown[]): void;

  debug(...args: unknown[]): void;

  info(...args: unknown[]): void;

  warn(...args: unknown[]): void;

  error(...args: unknown[]): void;

  setLogLevel(level: LogLevel): void;
}

/**
 * Nesting depth rendered by {@link formatLogArgs} for a non-Error value.
 * Node's default of 2 collapses anything deeper to `[Object]`, which loses the
 * detail a log line exists to carry; 5 keeps a nested payload readable while
 * still bounding log volume.
 */
const LOG_INSPECT_DEPTH = 5;

/** Renders a single log argument. */
function formatLogValue(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }
  if (value instanceof Error) {
    return value.stack ?? String(value);
  }
  return inspect(value, {depth: LOG_INSPECT_DEPTH});
}

/**
 * Formats the variadic arguments of a log call into a single line.
 *
 * Each argument is rendered so that nothing is silently lost: an `Error`
 * contributes its stack trace, a string is passed through unchanged, and any
 * other value is structurally inspected, so an object never degrades to
 * `[object Object]` and `undefined`/`null` never degrade to an empty string.
 * Arguments are joined with a single space.
 *
 * @param args The values passed to a logger level method.
 * @return A single string to hand to the underlying log transport.
 */
export function formatLogArgs(args: unknown[]): string {
  return args.map(formatLogValue).join(' ');
}

class SimpleLogger implements Logger {
  private readonly logger: winston.Logger;
  private logLevel: LogLevel = LogLevel.INFO;

  constructor() {
    this.logger = winston.createLogger({
      levels: {
        'debug': LogLevel.DEBUG,
        'info': LogLevel.INFO,
        'warn': LogLevel.WARN,
        'error': LogLevel.ERROR,
      },
      level: 'error',
      format: winston.format.combine(
        winston.format.label({label: 'ADK'}),
        winston.format((info) => {
          info.level = info.level.toUpperCase();
          return info;
        })(),
        winston.format.colorize(),
        winston.format.timestamp(),
        winston.format.printf((info) => {
          return `${info.level}: [${info.label}] ${info.timestamp} ${info.message}`;
        }),
      ),
      transports: [new winston.transports.Console()],
    });
  }

  setLogLevel(level: LogLevel): void {
    this.logLevel = level;
  }

  log(level: LogLevel, ...messages: unknown[]): void {
    if (this.logLevel > level) {
      return;
    }

    this.logger.log(level.toString(), formatLogArgs(messages));
  }

  debug(...messages: unknown[]): void {
    if (this.logLevel > LogLevel.DEBUG) {
      return;
    }

    this.logger.debug(formatLogArgs(messages));
  }

  info(...messages: unknown[]): void {
    if (this.logLevel > LogLevel.INFO) {
      return;
    }

    this.logger.info(formatLogArgs(messages));
  }

  warn(...messages: unknown[]): void {
    if (this.logLevel > LogLevel.WARN) {
      return;
    }

    this.logger.warn(formatLogArgs(messages));
  }

  error(...messages: unknown[]): void {
    if (this.logLevel > LogLevel.ERROR) {
      return;
    }

    this.logger.error(formatLogArgs(messages));
  }
}

/**
 * A no-op logger that discards all log messages.
 */
class NoOpLogger implements Logger {
  setLogLevel(_level: LogLevel): void {}
  log(_level: LogLevel, ..._args: unknown[]): void {}
  debug(..._args: unknown[]): void {}
  info(..._args: unknown[]): void {}
  warn(..._args: unknown[]): void {}
  error(..._args: unknown[]): void {}
}

let currentLogger: Logger = new SimpleLogger();

/**
 * Sets a custom logger for ADK, or null to disable logging.
 */
export function setLogger(customLogger: Logger | null): void {
  currentLogger = customLogger ?? new NoOpLogger();
}

/**
 * Gets the current logger instance.
 */
export function getLogger(): Logger {
  return currentLogger;
}

/**
 * Resets the logger to the default SimpleLogger.
 */
export function resetLogger(): void {
  currentLogger = new SimpleLogger();
}

/**
 * Sets the log level for the logger.
 */
export function setLogLevel(level: LogLevel) {
  logger.setLogLevel(level);
}

/**
 * The logger instance for ADK.
 */
export const logger: Logger = {
  setLogLevel(level: LogLevel): void {
    currentLogger.setLogLevel(level);
  },
  log(level: LogLevel, ...args: unknown[]): void {
    currentLogger.log(level, ...args);
  },
  debug(...args: unknown[]): void {
    currentLogger.debug(...args);
  },
  info(...args: unknown[]): void {
    currentLogger.info(...args);
  },
  warn(...args: unknown[]): void {
    currentLogger.warn(...args);
  },
  error(...args: unknown[]): void {
    currentLogger.error(...args);
  },
};
