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

describe('node_path_utils', () => {
  describe('nodeNameFromPath', () => {
    it('returns the leaf name without its run id', () => {
      expect(nodeNameFromPath('wf@1.node@2')).toBe('node');
    });

    it('returns the whole leaf segment when it carries no run id', () => {
      expect(nodeNameFromPath('wf@1.node')).toBe('node');
    });

    it('accepts the slash-separated form used by adk-python', () => {
      expect(nodeNameFromPath('wf@1/node@2')).toBe('node');
    });

    it('splits the name at the last @', () => {
      expect(nodeNameFromPath('wf.a@b@2')).toBe('a@b');
    });

    it('returns an empty string for an empty path', () => {
      expect(nodeNameFromPath('')).toBe('');
    });

    it('returns an empty string for an absent path', () => {
      expect(nodeNameFromPath(undefined)).toBe('');
    });
  });

  describe('runIdFromPath', () => {
    it('returns the run id of the leaf segment', () => {
      expect(runIdFromPath('wf@1.node@2')).toBe('2');
    });

    it('returns an empty string when the leaf carries no run id', () => {
      expect(runIdFromPath('wf@1.node')).toBe('');
    });

    it('returns an empty string for an empty path', () => {
      expect(runIdFromPath('')).toBe('');
    });

    it('returns an empty string for an absent path', () => {
      expect(runIdFromPath(undefined)).toBe('');
    });

    it('splits the run id at the last @', () => {
      expect(runIdFromPath('wf.a@b@2')).toBe('2');
    });
  });

  describe('parentRunIdFromPath', () => {
    it('returns the run id of the segment before the leaf', () => {
      expect(parentRunIdFromPath('wf@1.node@2')).toBe('1');
    });

    it('returns the run id of the direct parent of a deep leaf', () => {
      expect(parentRunIdFromPath('wf@1.mid@2.leaf@3')).toBe('2');
    });

    it('returns undefined for a single-segment path', () => {
      expect(parentRunIdFromPath('wf@1')).toBeUndefined();
    });

    it('returns undefined when the parent segment carries no run id', () => {
      expect(parentRunIdFromPath('wf.node@2')).toBeUndefined();
    });

    it('returns undefined for an empty path', () => {
      expect(parentRunIdFromPath('')).toBeUndefined();
    });

    it('returns undefined for an absent path', () => {
      expect(parentRunIdFromPath(undefined)).toBeUndefined();
    });
  });
});
