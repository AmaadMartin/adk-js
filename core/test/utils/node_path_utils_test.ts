/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {describe, expect, it} from 'vitest';
import {
  nodeNameFromPath,
  parentRunIdFromPath,
  runIdFromPath,
} from '../../src/utils/node_path_utils.js';

describe('nodeNameFromPath', () => {
  it('returns the leaf name for both separators', () => {
    expect(nodeNameFromPath('wf@1/node@2')).toBe('node');
    expect(nodeNameFromPath('wf@1.node@2')).toBe('node');
  });

  it('returns the leaf name when the leaf has no run id', () => {
    expect(nodeNameFromPath('wf@1/node')).toBe('node');
    expect(nodeNameFromPath('node')).toBe('node');
  });

  it('splits at the last @ so a name may contain one', () => {
    expect(nodeNameFromPath('a@b@2')).toBe('a@b');
  });

  it('returns an empty string for no path', () => {
    expect(nodeNameFromPath('')).toBe('');
    expect(nodeNameFromPath(undefined)).toBe('');
  });
});

describe('runIdFromPath', () => {
  it('returns the leaf run id for both separators', () => {
    expect(runIdFromPath('wf@1/node@2')).toBe('2');
    expect(runIdFromPath('wf@1.node@2')).toBe('2');
  });

  it('splits at the last @ so a name may contain one', () => {
    expect(runIdFromPath('a@b@2')).toBe('2');
  });

  it('returns an empty string when the leaf carries no run id', () => {
    expect(runIdFromPath('wf@1/node')).toBe('');
    expect(runIdFromPath('')).toBe('');
    expect(runIdFromPath(undefined)).toBe('');
  });
});

describe('parentRunIdFromPath', () => {
  it('returns the parent run id for both separators', () => {
    expect(parentRunIdFromPath('wf@1/node@2')).toBe('1');
    expect(parentRunIdFromPath('wf@1.node@2')).toBe('1');
  });

  it('reads the immediate parent, not the root', () => {
    expect(parentRunIdFromPath('wf@1/mid@2/leaf@3')).toBe('2');
  });

  it('returns undefined when the parent carries no run id', () => {
    expect(parentRunIdFromPath('wf/node@2')).toBeUndefined();
  });

  it('returns undefined for a single segment or no path', () => {
    expect(parentRunIdFromPath('wf@1')).toBeUndefined();
    expect(parentRunIdFromPath('')).toBeUndefined();
    expect(parentRunIdFromPath(undefined)).toBeUndefined();
  });
});
