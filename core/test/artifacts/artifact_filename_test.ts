/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {describe, expect, it} from 'vitest';
import {assertUnpaddedFilename} from '../../src/artifacts/artifact_filename.js';

describe('assertUnpaddedFilename', () => {
  const ACCEPTED: Array<[label: string, filename: string]> = [
    ['a plain filename', 'a.txt'],
    ['a dot-prefixed filename', '.hidden.txt'],
    ['an interior space', 'my report.txt'],
    ['a nested path', 'nested/dir/report.txt'],
    ['a user-scoped filename', 'user:a.txt'],
    ['the bare user prefix', 'user:'],
    ['an empty filename', ''],
    ['the current directory', '.'],
    ['the parent directory', '..'],
    ['an interior parent segment', 'a/../b.txt'],
  ];

  const REJECTED: Array<[label: string, filename: string]> = [
    ['a leading space', ' a.txt'],
    ['a trailing space', 'a.txt '],
    ['leading and trailing spaces', ' a.txt '],
    ['a trailing tab', 'a.txt\t'],
    ['a leading newline', '\na.txt'],
    ['only whitespace', '   '],
    ['padding after the user prefix', 'user: a.txt'],
    ['a trailing space after the user prefix', 'user:a.txt '],
    ['a padded parent segment', ' ../secret.txt'],
    ['a padded relative filename', ' ./a.txt'],
  ];

  it.each(ACCEPTED)('accepts %s', (_label, filename) => {
    expect(() => assertUnpaddedFilename(filename)).not.toThrow();
  });

  it.each(REJECTED)('rejects %s', (_label, filename) => {
    expect(() => assertUnpaddedFilename(filename)).toThrow(
      /leading or trailing whitespace/,
    );
  });

  it('reports the original filename including the user prefix', () => {
    expect(() => assertUnpaddedFilename('user: a.txt')).toThrow(
      'Artifact filename "user: a.txt" must not have leading or trailing whitespace.',
    );
  });
});
