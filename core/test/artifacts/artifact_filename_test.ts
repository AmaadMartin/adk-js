/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {describe, expect, it} from 'vitest';
import {assertValidArtifactFilename} from '../../src/artifacts/artifact_filename.js';

const ACCEPTED_FILENAMES: Array<[label: string, filename: string]> = [
  ['an interior period', 'a.txt'],
  ['a leading period', '.hidden.txt'],
  ['an interior space', 'my report.txt'],
  ['a nested path', 'nested/dir/report.txt'],
  ['a user: prefix', 'user:a.txt'],
  ['a current-directory segment', '.'],
  ['a parent-directory segment', '..'],
  ['an interior parent-directory segment', 'a/../b.txt'],
  ['an interior current-directory segment', 'nested/./report.txt'],
  ['no characters', ''],
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
});
