/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {describe, expect, it} from 'vitest';
import {isIdentifier} from '../../src/utils/identifier_utils.js';

describe('isIdentifier', () => {
  it.each([
    'name',
    'Name2',
    '_leading',
    '__START__',
    '$dollar',
    'a$b_c9',
    // ADK permits hyphens, unlike a plain JavaScript identifier.
    'ok-name',
    'a-b-c',
    // ID_Start / ID_Continue are Unicode, not ASCII.
    'café',
    'Ωmega',
    'переменная',
  ])('accepts %s', (name) => {
    expect(isIdentifier(name)).toBe(true);
  });

  it.each([
    '',
    ' ',
    'my name',
    '2fast',
    'a.b',
    'a@b',
    'a/b',
    'a:b',
    // A hyphen is ID_Continue here but never ID_Start.
    '-leading',
  ])('rejects %s', (name) => {
    expect(isIdentifier(name)).toBe(false);
  });
});
