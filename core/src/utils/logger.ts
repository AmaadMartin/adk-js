/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

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
 * A depth of 2 collapses anything deeper to `[Object]`, which loses the detail
 * a log line exists to carry; 5 keeps a nested payload readable while still
 * bounding log volume.
 */
const LOG_INSPECT_DEPTH = 5;

/** A property key that needs no quotes. */
const BARE_KEY = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

/** Renders a string as a quoted, escaped literal. */
function quote(text: string): string {
  const escaped = text
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'")
    .replace(/\n/g, '\\n');
  return `'${escaped}'`;
}

/** Renders the members of an array, an object, a `Map` or a `Set`. */
function joinMembers(open: string, members: string[], close: string): string {
  if (members.length === 0) {
    return `${open}${close}`;
  }
  return `${open} ${members.join(', ')} ${close}`;
}

/**
 * Renders a value structurally, in the style of `util.inspect`.
 *
 * This module is reachable from the browser entry point, so it cannot import
 * `node:util`. The renderer keeps `depth` levels of nesting, writes `[Object]`
 * below that, and writes `[Circular]` for a value that contains itself.
 *
 * @param value The value to render.
 * @param depth The number of nesting levels still to render.
 * @param seen The values that enclose this one, which marks a cycle.
 * @return The rendered value.
 */
function inspectValue(
  value: unknown,
  depth: number,
  seen: Set<object>,
): string {
  if (typeof value === 'string') {
    return quote(value);
  }
  if (typeof value === 'bigint') {
    return `${value}n`;
  }
  if (typeof value === 'function') {
    return `[Function: ${value.name || 'anonymous'}]`;
  }
  if (value === null || typeof value !== 'object') {
    return String(value);
  }
  if (value instanceof Error) {
    return value.stack ?? String(value);
  }
  if (seen.has(value)) {
    return '[Circular]';
  }
  if (depth < 0) {
    return Array.isArray(value) ? '[Array]' : '[Object]';
  }

  seen.add(value);
  try {
    if (Array.isArray(value)) {
      const items = value.map((item) => inspectValue(item, depth - 1, seen));
      return joinMembers('[', items, ']');
    }
    if (value instanceof Map) {
      const entries = [...value].map(
        ([key, item]) =>
          `${inspectValue(key, depth - 1, seen)} => ` +
          inspectValue(item, depth - 1, seen),
      );
      return `Map(${value.size}) ${joinMembers('{', entries, '}')}`;
    }
    if (value instanceof Set) {
      const items = [...value].map((item) =>
        inspectValue(item, depth - 1, seen),
      );
      return `Set(${value.size}) ${joinMembers('{', items, '}')}`;
    }
    // A Date, a RegExp or a URL renders itself through its own `toString`.
    if (value.toString !== Object.prototype.toString) {
      return String(value);
    }
    const className = value.constructor?.name;
    const prefix = className && className !== 'Object' ? `${className} ` : '';
    const entries = Object.entries(value).map(
      ([key, item]) =>
        `${BARE_KEY.test(key) ? key : quote(key)}: ` +
        inspectValue(item, depth - 1, seen),
    );
    return prefix + joinMembers('{', entries, '}');
  } finally {
    seen.delete(value);
  }
}

/** Renders a single log argument. */
function formatLogValue(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }
  if (value instanceof Error) {
    return value.stack ?? String(value);
  }
  return inspectValue(value, LOG_INSPECT_DEPTH, new Set());
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

/** The `console` method each level is written with. */
const CONSOLE_METHOD = {
  [LogLevel.DEBUG]: 'debug',
  [LogLevel.INFO]: 'info',
  [LogLevel.WARN]: 'warn',
  [LogLevel.ERROR]: 'error',
} as const;

/**
 * The default logger. Writes through `console` so that it works unchanged in
 * Node and in the browser. This module is reachable from the browser entry
 * point, so it must not name a Node-only package; the Node entry point
 * installs the winston-backed logger instead.
 * See https://github.com/google/adk-js/issues/611.
 */
class SimpleLogger implements Logger {
  private logLevel: LogLevel = LogLevel.INFO;

  setLogLevel(level: LogLevel): void {
    this.logLevel = level;
  }

  log(level: LogLevel, ...messages: unknown[]): void {
    if (this.logLevel > level) {
      return;
    }

    const timestamp = new Date().toISOString();
    const line = `${LogLevel[level]}: [ADK] ${timestamp} ${formatLogArgs(messages)}`;

    console[CONSOLE_METHOD[level]](line);
  }

  debug(...messages: unknown[]): void {
    this.log(LogLevel.DEBUG, ...messages);
  }

  info(...messages: unknown[]): void {
    this.log(LogLevel.INFO, ...messages);
  }

  warn(...messages: unknown[]): void {
    this.log(LogLevel.WARN, ...messages);
  }

  error(...messages: unknown[]): void {
    this.log(LogLevel.ERROR, ...messages);
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
 * Resets the logger to the built-in console logger. On Node this replaces the
 * winston-backed logger that the Node entry point installs.
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
