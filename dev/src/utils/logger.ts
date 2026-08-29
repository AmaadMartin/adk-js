/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {LogLevel, Logger} from '@google/adk';
import * as winston from 'winston';

/**
 * Winston levels of the ADK CLI loggers. `error` carries the highest number,
 * so `level: 'error'` lets every record reach the transports and each
 * AdkLogger gates emission itself.
 */
const WINSTON_LEVELS: Record<string, LogLevel> = {
  'debug': LogLevel.DEBUG,
  'info': LogLevel.INFO,
  'warn': LogLevel.WARN,
  'error': LogLevel.ERROR,
};

const PASS_THROUGH_LEVEL = 'error';

/**
 * Owner-only permissions for the log file. An agent log carries model prompts
 * and responses, and it sits at a predictable path inside a world-traversable
 * temp folder, so no other local user may read it.
 */
export const LOG_FILE_MODE = 0o600;

/**
 * Re-points one live logger at `transport`, or back at the console when
 * `transport` is `undefined`.
 */
type TransportSwap = (
  transport: winston.transports.FileTransportInstance | undefined,
) => void;

/**
 * One entry per live AdkLogger, so that a file target set after construction
 * still reaches loggers the dev package built at module load. This grows only
 * when an AdkLogger is constructed, never per log record.
 */
const transportSwaps = new Set<TransportSwap>();

let fileTransport: winston.transports.FileTransportInstance | undefined;

/**
 * Builds the log line written to a file. It mirrors adk-python's
 * `LOGGING_FORMAT`, with the logger label where Python puts
 * `filename:lineno`, which Node cannot supply without per-call stack
 * introspection. The format is deliberately not colorized: a file must not
 * receive ANSI escape sequences.
 */
function fileLogFormat(label: string): winston.Logform.Format {
  return winston.format.combine(
    // The `asctime` field of adk-python's `LOGGING_FORMAT`.
    winston.format.timestamp({format: 'YYYY-MM-DD HH:mm:ss,SSS'}),
    winston.format.printf(
      (info) =>
        `${info.timestamp} - ${info.level.toUpperCase()} - ${label} - ${info.message}`,
    ),
  );
}

/**
 * Sends every AdkLogger to `filePath` instead of the console, for the rest of
 * the process or until `resetFileLogTarget` is called. The file is truncated
 * on open, so one run leaves one file, as adk-python's `mode='w'` does.
 */
export function setFileLogTarget(filePath: string): void {
  fileTransport?.end();
  fileTransport = new winston.transports.File({
    filename: filePath,
    // The transport reopens the path, so it repeats the mode. Without it the
    // stream would create the file 0644 whenever the eager one is missing.
    options: {flags: 'w', mode: LOG_FILE_MODE},
  });
  for (const swap of transportSwaps) {
    swap(fileTransport);
  }
}

/**
 * Returns every AdkLogger to the console and waits for the log file to receive
 * what was written to it. `process.exit` drops buffered writes, so a caller
 * about to exit has to await this or lose the last records.
 */
export function resetFileLogTarget(): Promise<void> {
  const transport = fileTransport;
  if (!transport) {
    return Promise.resolve();
  }
  fileTransport = undefined;
  for (const swap of transportSwaps) {
    swap(undefined);
  }
  return new Promise((resolve) => {
    transport.once('finish', () => resolve());
    // A stream that fails emits `error` and never `finish`. This sits on the
    // path to `process.exit`, so waiting for a `finish` that cannot arrive
    // would hang the command instead of exiting.
    transport.once('error', () => resolve());
    transport.end();
  });
}

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
 * Logger implementation for the ADK CLI.
 */
export class AdkLogger implements Logger {
  private readonly logger: winston.Logger;
  private readonly label: string;
  private readonly consoleFormat: winston.Logform.Format;
  private logLevel: LogLevel = LogLevel.INFO;

  constructor(options: AdkLoggerOptions) {
    this.label = options.label;
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

    this.consoleFormat = winston.format.combine(...formats);
    this.logger = winston.createLogger();
    // `applyTransport` is the one place that configures the logger, and
    // `undefined` already means the console, so this covers construction
    // before and after a file target is set.
    this.applyTransport(fileTransport);
    transportSwaps.add((transport) => this.applyTransport(transport));
  }

  private applyTransport(
    transport: winston.transports.FileTransportInstance | undefined,
  ): void {
    this.logger.configure({
      levels: WINSTON_LEVELS,
      level: PASS_THROUGH_LEVEL,
      format: transport ? fileLogFormat(this.label) : this.consoleFormat,
      transports: [transport ?? new winston.transports.Console()],
    });
  }

  setLogLevel(level: LogLevel) {
    this.logLevel = level;
  }

  log(level: LogLevel, ...messages: unknown[]): void {
    if (this.logLevel > level) {
      return;
    }

    this.logger.log(level.toString(), messages.join(' '));
  }

  debug(...messages: unknown[]): void {
    if (this.logLevel > LogLevel.DEBUG) {
      return;
    }

    this.logger.debug(messages.join(' '));
  }

  info(...messages: unknown[]): void {
    if (this.logLevel > LogLevel.INFO) {
      return;
    }

    this.logger.info(messages.join(' '));
  }

  warn(...messages: unknown[]): void {
    if (this.logLevel > LogLevel.WARN) {
      return;
    }

    this.logger.warn(messages.join(' '));
  }

  error(...messages: unknown[]): void {
    if (this.logLevel > LogLevel.ERROR) {
      return;
    }

    this.logger.error(messages.join(' '));
  }
}
