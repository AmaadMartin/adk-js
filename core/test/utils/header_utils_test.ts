/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {describe, expect, it} from 'vitest';

import {mergeHeaders, toHeaderRecord} from '../../src/utils/header_utils.js';

describe('toHeaderRecord', () => {
  it('returns an empty record for no headers', () => {
    expect(toHeaderRecord()).toEqual({});
  });

  it('keeps a plain object as it is', () => {
    expect(toHeaderRecord({'X-One': '1'})).toEqual({'X-One': '1'});
  });

  it('reads a Headers instance', () => {
    const headers = new Headers();
    headers.set('X-One', '1');
    headers.set('X-Two', '2');

    // `Headers` lower-cases the names it stores.
    expect(toHeaderRecord(headers)).toEqual({'x-one': '1', 'x-two': '2'});
  });

  it('reads an array of name and value pairs', () => {
    expect(
      toHeaderRecord([
        ['X-One', '1'],
        ['X-Two', '2'],
      ]),
    ).toEqual({'X-One': '1', 'X-Two': '2'});
  });
});

describe('mergeHeaders', () => {
  it('keeps the entries that no override matches', () => {
    expect(mergeHeaders({'X-One': '1'}, {'X-Two': '2'})).toEqual({
      'X-One': '1',
      'X-Two': '2',
    });
  });

  it('replaces an entry whose name matches exactly', () => {
    expect(mergeHeaders({'X-One': 'old'}, {'X-One': 'new'})).toEqual({
      'X-One': 'new',
    });
  });

  it('replaces an entry whose name differs only in case', () => {
    expect(
      mergeHeaders({authorization: 'old'}, {Authorization: 'new'}),
    ).toEqual({Authorization: 'new'});
  });

  it('leaves the base alone when there is nothing to override', () => {
    const base = {'X-One': '1'};

    expect(mergeHeaders(base, {})).toEqual({'X-One': '1'});
    expect(base).toEqual({'X-One': '1'});
  });
});
