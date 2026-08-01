/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
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
 * Winston format options for a {@link WinstonLogger}.
 */
export interface WinstonLoggerOptions {
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

/** Process-wide default level for loggers that were never explicitly pinned. */
let defaultLogLevel: LogLevel = LogLevel.INFO;

/**
 * A level-gated {@link Logger} backed by winston.
 *
 * The level is resolved on every log call as the instance pin when
 * {@link WinstonLogger.setLogLevel} was called on this instance, and the
 * process-wide default set by {@link setLogLevel} otherwise. Resolving it at
 * log time is what lets a single `setLogLevel` call reach loggers that were
 * already constructed.
 */
export class WinstonLogger implements Logger {
  private readonly logger: winston.Logger;
  private logLevel?: LogLevel;

  constructor(options: WinstonLoggerOptions) {
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

  /** Pins this instance's level, overriding the process-wide default. */
  setLogLevel(level: LogLevel): void {
    this.logLevel = level;
  }

  private isEnabled(level: LogLevel): boolean {
    return (this.logLevel ?? defaultLogLevel) <= level;
  }

  log(level: LogLevel, ...messages: unknown[]): void {
    if (!this.isEnabled(level)) {
      return;
    }

    // The winston level names are the LogLevel member names, lowercased; see
    // the `levels` map above.
    this.logger.log(LogLevel[level].toLowerCase(), messages.join(' '));
  }

  debug(...messages: unknown[]): void {
    if (!this.isEnabled(LogLevel.DEBUG)) {
      return;
    }

    this.logger.debug(messages.join(' '));
  }

  info(...messages: unknown[]): void {
    if (!this.isEnabled(LogLevel.INFO)) {
      return;
    }

    this.logger.info(messages.join(' '));
  }

  warn(...messages: unknown[]): void {
    if (!this.isEnabled(LogLevel.WARN)) {
      return;
    }

    this.logger.warn(messages.join(' '));
  }

  error(...messages: unknown[]): void {
    if (!this.isEnabled(LogLevel.ERROR)) {
      return;
    }

    this.logger.error(messages.join(' '));
  }
}

/** Format options for the built-in ADK logger. */
const DEFAULT_LOGGER_OPTIONS: WinstonLoggerOptions = {
  label: 'ADK',
  colorize: {level: true},
  timestamp: true,
  printFormat: (info) =>
    `${info.level}: [${info.label}] ${info.timestamp} ${info.message}`,
};

class SimpleLogger extends WinstonLogger {
  constructor() {
    super(DEFAULT_LOGGER_OPTIONS);
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
 *
 * This sets the process-wide default that every built-in ADK logger follows,
 * including loggers already constructed in other ADK packages, unless that
 * logger was pinned with its own `setLogLevel` call.
 */
export function setLogLevel(level: LogLevel) {
  defaultLogLevel = level;
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
