/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as os from 'node:os';

/** Characters that separate words, matching Python `shlex`'s `whitespace`. */
const WHITESPACE = new Set([' ', '\t', '\r', '\n']);

const SINGLE_QUOTE = "'";
const DOUBLE_QUOTE = '"';
const ESCAPE = '\\';

/** Message Python's `shlex.split` raises for an unterminated quote. */
const NO_CLOSING_QUOTATION = 'No closing quotation';

/** Message Python's `shlex.split` raises for a trailing backslash. */
const NO_ESCAPED_CHARACTER = 'No escaped character';

/**
 * Splits a command line into argv the way POSIX `shlex.split` does.
 *
 * Whitespace separates words. Single quotes are literal. Inside double quotes
 * only `\"` and `\\` are escapes, and every other backslash is kept — this is
 * `shlex`, not bash, so `` \` `` and `\$` stay two characters. Outside quotes a
 * backslash escapes the next character. Shell operators carry no meaning here:
 * `ls ; rm -rf /` tokenizes to four plain words.
 *
 * @param command The command line to tokenize.
 * @return The tokens, or an empty array when `command` holds no word.
 * @throws If a quote is never closed, or the line ends with a backslash.
 */
export function splitCommand(command: string): string[] {
  const tokens: string[] = [];
  let token = '';
  let started = false;
  let quote: string | undefined;

  for (let i = 0; i < command.length; i++) {
    const char = command[i];

    if (char === ESCAPE && quote !== SINGLE_QUOTE) {
      const escaped = command[i + 1];
      if (escaped === undefined) {
        throw new Error(NO_ESCAPED_CHARACTER);
      }
      if (
        quote === DOUBLE_QUOTE &&
        escaped !== DOUBLE_QUOTE &&
        escaped !== ESCAPE
      ) {
        token += ESCAPE;
      }
      token += escaped;
      started = true;
      i++;
    } else if (quote !== undefined) {
      if (char === quote) {
        quote = undefined;
      } else {
        token += char;
      }
    } else if (char === SINGLE_QUOTE || char === DOUBLE_QUOTE) {
      quote = char;
      started = true;
    } else if (WHITESPACE.has(char)) {
      if (started) {
        tokens.push(token);
        token = '';
        started = false;
      }
    } else {
      token += char;
      started = true;
    }
  }

  if (quote !== undefined) {
    throw new Error(NO_CLOSING_QUOTATION);
  }
  if (started) {
    tokens.push(token);
  }
  return tokens;
}

/**
 * Maps Node's `(code, signal)` child exit pair onto the POSIX return code
 * Python reports: the exit status, or the negative signal number when a signal
 * killed the process.
 *
 * @param code The exit status, or `null` when a signal ended the process.
 * @param signal The terminating signal, or `null` when the process exited.
 * @return The return code.
 */
export function toReturnCode(
  code: number | null,
  signal: keyof typeof os.constants.signals | null,
): number {
  return signal === null ? (code ?? 0) : -os.constants.signals[signal];
}
