/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type {ChildProcessByStdio} from 'node:child_process';
import * as os from 'node:os';
import type {Readable, Writable} from 'node:stream';

/** Characters that separate words, matching Python `shlex`'s `whitespace`. */
const WHITESPACE = new Set([' ', '\t', '\r', '\n']);

const SINGLE_QUOTE = "'";
const DOUBLE_QUOTE = '"';
const ESCAPE = '\\';

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
 * @throws `No closing quotation` if a quote is never closed, or `No escaped
 *   character` if the line ends with a backslash, as `shlex.split` does.
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
        throw new Error('No escaped character');
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
    throw new Error('No closing quotation');
  }
  if (started) {
    tokens.push(token);
  }
  return tokens;
}

/** A spawned child whose stdout and stderr are pipes. */
type PipedChild = ChildProcessByStdio<Writable | null, Readable, Readable>;

/** What a child process produced, once it closed. */
export interface ChildOutput {
  /** The decoded standard output. `''` when the child wrote nothing. */
  stdout: string;
  /** The decoded standard error. `''` when the child wrote nothing. */
  stderr: string;
  /** The exit status, or the negative signal number. */
  returncode: number;
  /** Whether the timeout expired before the child closed. */
  timedOut: boolean;
}

/**
 * Buffers a running child's output and applies an optional timeout.
 *
 * On timeout the read ends of both pipes are released as well as the kill,
 * because `'close'` waits for the write ends to reach EOF. A process the kill
 * did not reach still holds one — a command the child forked, or one that put
 * itself in a new session — and without the release the call would last as
 * long as that survivor, not as long as the budget.
 *
 * @param child A spawned child with piped stdout and stderr.
 * @param timeoutSeconds The wall-clock budget, or `null` for none.
 * @param killOnTimeout Ends the child once the budget expires. The caller
 *   supplies it because the mechanism differs: killing a process group is
 *   POSIX-only, so a cross-platform caller kills the child alone.
 * @return The output the child produced before it closed.
 * @throws Whatever the child's `error` event reports, such as a failed spawn.
 */
export async function collectChildOutput(
  child: PipedChild,
  timeoutSeconds: number | null,
  killOnTimeout: () => void,
): Promise<ChildOutput> {
  const stdoutChunks: Buffer[] = [];
  const stderrChunks: Buffer[] = [];
  child.stdout.on('data', (chunk: Buffer) => stdoutChunks.push(chunk));
  child.stderr.on('data', (chunk: Buffer) => stderrChunks.push(chunk));

  let timedOut = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  if (timeoutSeconds !== null) {
    timer = setTimeout(() => {
      timedOut = true;
      killOnTimeout();
      child.stdout.destroy();
      child.stderr.destroy();
    }, timeoutSeconds * 1000);
  }

  try {
    const returncode = await new Promise<number>((resolve, reject) => {
      // 'close' rather than 'exit': the stdio streams are drained by then.
      // The return code follows Python: the exit status, or the negative
      // signal number when a signal ended the process. Node types `code` as
      // nullable and promises nothing more, so a missing status reports 0
      // rather than a null typed as a number.
      child.on('close', (code, signal) =>
        resolve(signal === null ? (code ?? 0) : -os.constants.signals[signal]),
      );
      child.on('error', reject);
    });
    return {
      // Joined before decoding, so a multi-byte character split across two
      // chunks survives. An invalid byte becomes U+FFFD, as Python's
      // errors='replace' does.
      stdout: Buffer.concat(stdoutChunks).toString('utf-8'),
      stderr: Buffer.concat(stderrChunks).toString('utf-8'),
      returncode,
      timedOut,
    };
  } finally {
    clearTimeout(timer);
  }
}
