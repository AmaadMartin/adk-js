/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {describe, expect, it} from 'vitest';
import {
  assertValidArtifactFilename,
  stripUserNamespace,
} from '../../src/artifacts/artifact_filename.js';

const ACCEPTED_FILENAMES: Array<[label: string, filename: string]> = [
  ['an interior period', 'a.txt'],
  ['a leading period', '.hidden.txt'],
  ['an interior space', 'my report.txt'],
  ['a nested path', 'nested/dir/report.txt'],
  ['a user: prefix', 'user:a.txt'],
  ['a nested path after the user: prefix', 'user:nested/a.txt'],
  ['only the user: prefix', 'user:'],
  ['a current-directory segment', '.'],
  ['a parent-directory segment', '..'],
  ['an interior parent-directory segment', 'a/../b.txt'],
  ['an interior current-directory segment', 'nested/./report.txt'],
  ['no characters', ''],
  ['a device name in the extension', 'a.nul'],
  ['a device name as a prefix of the stem', 'null.txt'],
  ['a plural device name', 'nulls.csv'],
  ['a word starting with a device name', 'connections.txt'],
  ['a word starting with AUX', 'auxiliary.txt'],
  ['a device name after a hyphen', 'my-con.txt'],
  ['the unreserved COM0', 'com0.txt'],
  ['the unreserved LPT10', 'lpt10.txt'],
  ['the unreserved CON2', 'con2.txt'],
  ['an apostrophe', "a'b.txt"],
  ['parentheses', 'a(b).txt'],
  ['a plus and an equals sign', 'a+b=c.txt'],
  ['a hash', '#hash.txt'],
  ['a backslash', 'a\\b.txt'],
];

const REJECTED_DEVICE_NAMES: Array<[label: string, filename: string]> = [
  ['a lowercase device name', 'nul.txt'],
  ['a bare device name', 'NUL'],
  ['a mixed-case device name', 'nUl.TXT'],
  ['a bare lowercase CON', 'con'],
  ['CON with an extension', 'CON.txt'],
  ['a bare AUX', 'aux'],
  ['PRN with an extension', 'prn.log'],
  ['COM1', 'com1.txt'],
  ['COM9', 'COM9'],
  ['a bare LPT1', 'lpt1'],
  ['LPT9 with an extension', 'LPT9.dat'],
  ['a device name in an interior segment', 'nested/nul/report.txt'],
  ['a device name in the first segment', 'nul/a.txt'],
  ['a device name after the user: prefix', 'user:nul.txt'],
  ['a trailing space in the device stem', 'nul .txt'],
  ['a device name before two extensions', 'con.tar.gz'],
  ['a backslash-separated device name', 'nested\\nul\\a.txt'],
];

const REJECTED_CHARACTERS: Array<[label: string, filename: string]> = [
  ['a less-than sign', 'a<b.txt'],
  ['a greater-than sign', 'a>b.txt'],
  ['a colon', 'a:b.txt'],
  ['a double quote', 'a"b.txt'],
  ['a pipe', 'a|b.txt'],
  ['a question mark', 'a?b.txt'],
  ['an asterisk', 'a*b.txt'],
  ['a null character', 'a\u0000b.txt'],
  ['the last control character', 'a\u001fb.txt'],
  ['a tab', 'a\tb.txt'],
  ['a colon in an interior segment', 'nested/a:b.txt'],
  ['a colon after the user: prefix', 'user:a:b.txt'],
  ['a drive qualifier', 'C:/abs.txt'],
];

const REJECTED_PADDED_SEGMENTS: Array<[label: string, filename: string]> = [
  ['a trailing space on an interior segment', 'nested /report.txt'],
  ['a leading space on the last segment', 'nested/ report.txt'],
  ['a backslash-separated padded segment', 'nested\\report \\a.txt'],
];

const REJECTED_FILENAMES: Array<[label: string, filename: string]> = [
  ['a trailing period', 'a.'],
  ['two trailing periods', 'a..'],
  ['only periods', '...'],
  ['a trailing period after an extension', 'trailing.dot.'],
  ['a trailing period on an interior segment', 'nested./report.txt'],
  ['a trailing period on the last segment', 'nested/report.'],
  ['a backslash-separated trailing period', 'nested\\report.'],
  ['a trailing period after the user: prefix', 'user:trailing.dot.'],
];

describe('assertValidArtifactFilename', () => {
  it.each(ACCEPTED_FILENAMES)('accepts a filename with %s', (_l, filename) => {
    expect(() => assertValidArtifactFilename(filename)).not.toThrow();
  });

  it.each(REJECTED_FILENAMES)('rejects a filename with %s', (_l, filename) => {
    expect(() => assertValidArtifactFilename(filename)).toThrow(
      /must not have a path segment ending in a period/,
    );
  });

  it('reports the original filename including the user: prefix', () => {
    expect(() => assertValidArtifactFilename('user:trailing.dot.')).toThrow(
      'Artifact filename "user:trailing.dot." must not have a path segment ending in a period.',
    );
  });

  it.each(REJECTED_PADDED_SEGMENTS)(
    'rejects a filename with %s',
    (_l, filename) => {
      expect(() => assertValidArtifactFilename(filename)).toThrow(
        /must not have a path segment with leading or trailing whitespace/,
      );
    },
  );

  it.each(REJECTED_DEVICE_NAMES)(
    'rejects a filename with %s',
    (_l, filename) => {
      expect(() => assertValidArtifactFilename(filename)).toThrow(
        /must not use the reserved device name/,
      );
    },
  );

  it.each(REJECTED_CHARACTERS)('rejects a filename with %s', (_l, filename) => {
    expect(() => assertValidArtifactFilename(filename)).toThrow(
      /must not contain a character reserved by Windows/,
    );
  });

  it('reports the uppercased device name and the original filename', () => {
    expect(() => assertValidArtifactFilename('user:nul.txt')).toThrow(
      'Artifact filename "user:nul.txt" must not use the reserved device name "NUL".',
    );
  });

  it('names every reserved character in the character message', () => {
    expect(() => assertValidArtifactFilename('a:b.txt')).toThrow(
      'Artifact filename "a:b.txt" must not contain a character reserved by Windows (< > : " | ? * or a control character).',
    );
  });

  it('checks reserved characters before the device name', () => {
    expect(() => assertValidArtifactFilename('nul:1.txt')).toThrow(
      'Artifact filename "nul:1.txt" must not contain a character reserved by Windows (< > : " | ? * or a control character).',
    );
  });
});

describe('stripUserNamespace', () => {
  it('removes a leading user: prefix', () => {
    expect(stripUserNamespace('user:a.txt')).toBe('a.txt');
  });

  it('keeps a user: prefix that is not leading', () => {
    expect(stripUserNamespace('notuser:a.txt')).toBe('notuser:a.txt');
  });
});
