/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {describe, expect, it} from 'vitest';
import {splitCommand} from '../../src/utils/shell_utils.js';

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
