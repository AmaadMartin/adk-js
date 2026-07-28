/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {validatePathSegment} from '@google/adk';
import {describe, expect, it} from 'vitest';

describe('evaluation/path_validation', () => {
  it.each(['eval_set_1', 'my-app', 'App Name 1', 'résumé', 'a.b.c'])(
    'accepts valid value %s',
    (value) => {
      expect(() => validatePathSegment(value, 'field')).not.toThrow();
    },
  );

  it('rejects an empty value', () => {
    expect(() => validatePathSegment('', 'field')).toThrow('must not be empty');
  });

  it('rejects a null byte', () => {
    expect(() => validatePathSegment('foo\x00bar', 'field')).toThrow(
      'must not contain null bytes',
    );
  });

  it.each(['foo/bar', 'foo\\bar', '/', '\\'])(
    'rejects path separators in %j',
    (value) => {
      expect(() => validatePathSegment(value, 'field')).toThrow(
        'must not contain path separators',
      );
    },
  );

  it.each(['.', '..'])('rejects traversal segment %j', (value) => {
    expect(() => validatePathSegment(value, 'field')).toThrow(
      'must not contain traversal segments',
    );
  });

  it('includes the field name in the error', () => {
    expect(() => validatePathSegment('', 'eval_set_id')).toThrow('eval_set_id');
  });
});
