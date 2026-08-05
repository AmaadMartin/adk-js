/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as os from 'node:os';
import * as path from 'node:path';
import {describe, expect, it} from 'vitest';
import {isPathInside} from '../../src/utils/path_utils.js';

describe('isPathInside', () => {
  it('accepts the base directory itself', () => {
    expect(isPathInside('/tmp/root', '/tmp/root')).toBe(true);
  });

  it('accepts a direct child of the base directory', () => {
    expect(isPathInside('/tmp/root', '/tmp/root/a.txt')).toBe(true);
  });

  it('accepts a deeply nested child of the base directory', () => {
    expect(isPathInside('/tmp/root', '/tmp/root/users/alice/x')).toBe(true);
  });

  it('rejects the parent of the base directory', () => {
    expect(isPathInside('/tmp/root', '/tmp')).toBe(false);
  });

  it('rejects a target that traverses out of the base directory', () => {
    expect(isPathInside('/tmp/root', '/tmp/root/../outside')).toBe(false);
  });

  it('rejects a sibling directory sharing a name prefix', () => {
    expect(isPathInside('/tmp/agent', '/tmp/agent-evil/x')).toBe(false);
  });

  it('rejects a sibling that is an exact string prefix of the base', () => {
    expect(isPathInside('/tmp/root', '/tmp/rootx')).toBe(false);
  });

  it('accepts a file whose name starts with two dots', () => {
    expect(isPathInside('/tmp/root', '/tmp/root/..hidden.txt')).toBe(true);
  });

  it('accepts a directory whose name starts with two dots', () => {
    expect(isPathInside('/tmp/root', '/tmp/root/..hidden/child.txt')).toBe(
      true,
    );
  });

  it('accepts a child when the base directory is the filesystem root', () => {
    expect(isPathInside('/', '/foo')).toBe(true);
  });

  it('accepts the filesystem root as its own base', () => {
    expect(isPathInside('/', '/')).toBe(true);
  });

  it('accepts a child of a base directory with a trailing separator', () => {
    expect(isPathInside('/tmp/root/', '/tmp/root/a')).toBe(true);
  });

  it('resolves a base directory that contains an embedded parent segment', () => {
    expect(isPathInside('/tmp/root/../root', '/tmp/root/a')).toBe(true);
  });

  it('resolves a target that contains an embedded parent segment', () => {
    expect(isPathInside('/tmp/root/', '/tmp/root/sub/../in.txt')).toBe(true);
  });

  it('resolves relative arguments against the working directory', () => {
    expect(isPathInside('.', 'sub/file.txt')).toBe(true);
  });

  it('rejects a relative target that escapes the working directory', () => {
    expect(isPathInside('.', '../outside')).toBe(false);
  });

  it('reads its arguments as (base, target), not (target, base)', () => {
    expect(isPathInside('/tmp', '/tmp/root')).toBe(true);
    expect(isPathInside('/tmp/root', '/tmp')).toBe(false);
  });

  it.runIf(os.platform() === 'win32')(
    'rejects a target on another Windows drive',
    () => {
      expect(isPathInside('C:\\base', 'D:\\base\\child')).toBe(false);
      expect(
        path.isAbsolute(path.relative('C:\\base', 'D:\\base\\child')),
      ).toBe(true);
    },
  );
});
