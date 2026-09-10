/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {describe, expect, it} from 'vitest';

import {isJsonObject, parseFencedJson} from '../../src/utils/json_utils.js';

describe('isJsonObject', () => {
  it('accepts a keyed object', () => {
    expect(isJsonObject({a: 1})).toBe(true);
  });

  it('rejects an array', () => {
    expect(isJsonObject([1, 2])).toBe(false);
  });

  it('rejects null', () => {
    expect(isJsonObject(null)).toBe(false);
  });

  it('rejects a scalar', () => {
    expect(isJsonObject(42)).toBe(false);
    expect(isJsonObject('text')).toBe(false);
  });
});

describe('parseFencedJson', () => {
  it('parses plain JSON', () => {
    expect(parseFencedJson('{"a": 1}')).toEqual({a: 1});
  });

  it('strips a fence that names a language', () => {
    expect(parseFencedJson('```json\n{"a": 1}\n```')).toEqual({a: 1});
  });

  it('strips a fence that names no language', () => {
    expect(parseFencedJson('```\n{"a": 1}\n```')).toEqual({a: 1});
  });

  it('strips a fence whose answer ends with a newline', () => {
    // The ordinary shape of a fenced model answer. adk-python's `$` matches
    // just before a trailing newline and JavaScript's does not, so the fence
    // has to be reachable after trimming.
    expect(parseFencedJson('```json\n{"a": 1}\n```\n')).toEqual({a: 1});
  });

  it('strips a fence padded with whitespace on both sides', () => {
    expect(parseFencedJson('\n  ```json\n{"a": 1}\n```  \n')).toEqual({a: 1});
  });

  it('strips a fence whose answer ends with a carriage return', () => {
    expect(parseFencedJson('```json\n{"a": 1}\n```\r\n')).toEqual({a: 1});
  });

  it('trims surrounding whitespace', () => {
    expect(parseFencedJson('  \n{"a": 1}\n  ')).toEqual({a: 1});
  });

  it('leaves a fence in the middle of the text alone', () => {
    expect(parseFencedJson('{"a": "```"}')).toEqual({a: '```'});
  });

  it('returns undefined for text that is not JSON', () => {
    expect(parseFencedJson('sorry, I cannot do that')).toBeUndefined();
  });

  it('returns undefined for the empty string', () => {
    expect(parseFencedJson('')).toBeUndefined();
  });

  it('returns the parsed scalar for a JSON scalar', () => {
    expect(parseFencedJson('42')).toBe(42);
    expect(parseFencedJson('null')).toBeNull();
  });
});
