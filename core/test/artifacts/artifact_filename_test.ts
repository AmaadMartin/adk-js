/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {describe, expect, it} from 'vitest';
import {assertNoCaseCollision} from '../../src/artifacts/artifact_filename.js';

describe('assertNoCaseCollision', () => {
  it('throws for a filename that differs only in case', () => {
    expect(() =>
      assertNoCaseCollision(['a.txt', 'Report.txt'], 'report.txt'),
    ).toThrow(/differs only in case/);
  });

  it('names both filenames in the error message', () => {
    expect(() => assertNoCaseCollision(['Report.txt'], 'report.txt')).toThrow(
      'Artifact filename "report.txt" differs only in case from existing ' +
        'artifact "Report.txt".',
    );
  });

  it('throws when the case differs inside the filename', () => {
    expect(() => assertNoCaseCollision(['a-B.txt'], 'A-b.txt')).toThrow(
      /differs only in case/,
    );
  });

  it('does not throw for an identical filename', () => {
    expect(() =>
      assertNoCaseCollision(['report.txt'], 'report.txt'),
    ).not.toThrow();
  });

  it('does not throw for an unrelated filename', () => {
    expect(() =>
      assertNoCaseCollision(['Report.txt'], 'summary.txt'),
    ).not.toThrow();
  });

  it('does not throw when no artifact is stored yet', () => {
    expect(() => assertNoCaseCollision([], 'report.txt')).not.toThrow();
  });
});
