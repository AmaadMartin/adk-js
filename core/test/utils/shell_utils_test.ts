/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {spawn} from 'node:child_process';
import {describe, expect, it} from 'vitest';
import {
  ChildOutput,
  collectChildOutput,
  splitCommand,
} from '../../src/utils/shell_utils.js';

/** Spawning a child process is slow on a loaded CI runner. */
const SPAWN_TIMEOUT_MS = 30_000;

/** How long the killed script runs if nothing ends it. */
const SURVIVOR_LIFETIME_MS = 10_000;

/** Short enough that the kill lands well before the script would exit. */
const KILL_AFTER_SECONDS = 0.2;

/**
 * Enough '€' to overflow the pipe buffer on every platform we test.
 *
 * A pipe hands over a power-of-two number of bytes at a time, and 3 divides no
 * power of two, so the first boundary always falls inside a character.
 */
const EURO_REPEATS = 40_000;

describe('splitCommand', () => {
  it('returns no token for an empty or blank command', () => {
    expect(splitCommand('')).toEqual([]);
    expect(splitCommand('   ')).toEqual([]);
    expect(splitCommand('\t\r\n')).toEqual([]);
  });

  it('splits on runs of whitespace', () => {
    expect(splitCommand('ls -la')).toEqual(['ls', '-la']);
    expect(splitCommand('  ls \t -la \n')).toEqual(['ls', '-la']);
  });

  it('keeps a single-quoted run as one token', () => {
    expect(splitCommand("echo 'hello world'")).toEqual(['echo', 'hello world']);
  });

  it('keeps a double-quoted run as one token', () => {
    expect(splitCommand('echo "a b"')).toEqual(['echo', 'a b']);
  });

  it('unescapes the quote and the backslash inside double quotes', () => {
    expect(splitCommand('echo "a\\"b"')).toEqual(['echo', 'a"b']);
    expect(splitCommand('echo "a\\\\b"')).toEqual(['echo', 'a\\b']);
  });

  it('keeps any other backslash inside double quotes, as shlex does', () => {
    expect(splitCommand('echo "a\\$b"')).toEqual(['echo', 'a\\$b']);
    expect(splitCommand('echo "a\\`b"')).toEqual(['echo', 'a\\`b']);
  });

  it('escapes the next character outside quotes', () => {
    expect(splitCommand('echo a\\ b')).toEqual(['echo', 'a b']);
    expect(splitCommand('echo a\\"b')).toEqual(['echo', 'a"b']);
  });

  it('treats a backslash inside single quotes as literal', () => {
    expect(splitCommand("echo 'a\\b'")).toEqual(['echo', 'a\\b']);
  });

  it('concatenates adjacent quoted runs', () => {
    expect(splitCommand('echo \'a\'"b"')).toEqual(['echo', 'ab']);
  });

  it('emits an empty token for an empty quoted run', () => {
    expect(splitCommand("echo ''")).toEqual(['echo', '']);
  });

  it('throws when a quote is never closed', () => {
    expect(() => splitCommand('echo "a')).toThrow('No closing quotation');
    expect(() => splitCommand("echo 'a")).toThrow('No closing quotation');
  });

  it('throws when the command ends with a backslash', () => {
    expect(() => splitCommand('echo a\\')).toThrow('No escaped character');
  });

  /**
   * This is the test that pins the no-shell decision: the tool spawns the
   * tokens directly, so an operator is an argument and never syntax.
   */
  it('tokenizes shell operators as plain words', () => {
    expect(splitCommand('ls ; rm -rf /')).toEqual([
      'ls',
      ';',
      'rm',
      '-rf',
      '/',
    ]);
    expect(splitCommand('echo hello | grep h')).toEqual([
      'echo',
      'hello',
      '|',
      'grep',
      'h',
    ]);
  });
});

/** Runs `script` under the Node binary and collects what it produced. */
function runScript(
  script: string,
  timeoutSeconds: number | null = null,
): Promise<ChildOutput> {
  const child = spawn(process.execPath, ['-e', script], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return collectChildOutput(child, timeoutSeconds, () => child.kill('SIGKILL'));
}

describe('collectChildOutput return code', () => {
  it('reports an exit status as itself', async () => {
    await expect(runScript('process.exit(42)')).resolves.toMatchObject({
      returncode: 42,
    });
  });

  it(
    'reports a terminating signal as its negative number',
    async () => {
      const result = await runScript(
        `setTimeout(() => {}, ${SURVIVOR_LIFETIME_MS})`,
        KILL_AFTER_SECONDS,
      );
      expect(result).toMatchObject({returncode: -9, timedOut: true});
    },
    SPAWN_TIMEOUT_MS,
  );
});

describe('collectChildOutput decoding', () => {
  it('returns an empty string when nothing was captured', async () => {
    await expect(runScript('')).resolves.toMatchObject({
      stdout: '',
      stderr: '',
    });
  });

  it(
    'keeps a multi-byte character split across two chunks intact',
    async () => {
      const result = await runScript(
        `const text = '\\u20ac'.repeat(${EURO_REPEATS});` +
          'process.stdout.write(text);' +
          'process.stderr.write(text);',
      );
      // Decoding a chunk on its own turns the split character into two
      // replacement characters, which lengthens the text as well.
      expect(result.stdout).toBe(result.stderr);
      expect(result.stdout).not.toContain('\uFFFD');
      expect(result.stdout).toHaveLength(EURO_REPEATS);
    },
    SPAWN_TIMEOUT_MS,
  );

  it('replaces an invalid byte rather than throwing', async () => {
    const result = await runScript(
      'process.stdout.write(Buffer.from([0xff]));' +
        'process.stderr.write(Buffer.from([0xff]));',
    );
    expect(result).toMatchObject({stdout: '\uFFFD', stderr: '\uFFFD'});
  });
});
