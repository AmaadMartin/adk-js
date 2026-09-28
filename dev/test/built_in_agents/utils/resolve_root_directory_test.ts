/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import {afterEach, describe, expect, it, vi} from 'vitest';

import {
  resolveFilePath,
  resolveFilePaths,
  rootDirectoryFromContext,
} from '../../../src/built_in_agents/utils/resolve_root_directory.js';
import {createTestContext, useTempDirs} from '../test_helpers.js';

describe('resolveFilePath', () => {
  const tempDir = useTempDirs();

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('allows a path within the root', async () => {
    const root = await tempDir();

    expect(resolveFilePath('sub/dir/file.txt', root)).toBe(
      path.join(root, 'sub', 'dir', 'file.txt'),
    );
  });

  it('allows "." and resolves it to the root itself', async () => {
    const root = await tempDir();

    expect(resolveFilePath('.', root)).toBe(path.resolve(root));
  });

  it('allows an interior ".." that stays inside the root', async () => {
    const root = await tempDir();

    expect(resolveFilePath('sub/../file.txt', root)).toBe(
      path.join(root, 'file.txt'),
    );
  });

  it('allows an absolute path inside the root', async () => {
    const root = await tempDir();
    const target = path.join(root, 'nested', 'ok.txt');

    expect(resolveFilePath(target, root)).toBe(target);
  });

  it('sanitizes a quoted path before resolving it', async () => {
    const root = await tempDir();

    expect(resolveFilePath("'tools/web.yaml'", root)).toBe(
      path.join(root, 'tools', 'web.yaml'),
    );
  });

  it('resolves a relative root against the working directory', async () => {
    const root = await tempDir();
    vi.spyOn(process, 'cwd').mockReturnValue(root);

    expect(resolveFilePath('file.txt', 'project')).toBe(
      path.join(root, 'project', 'file.txt'),
    );
  });

  it('rejects a traversal out of a relative root', async () => {
    const root = await tempDir();
    vi.spyOn(process, 'cwd').mockReturnValue(root);

    expect(() => resolveFilePath('../escape.txt', 'project')).toThrow(
      'resolves outside the root directory',
    );
  });

  it('rejects a relative traversal', async () => {
    const root = await tempDir();

    expect(() => resolveFilePath('../../escape.txt', root)).toThrow(
      `File path '../../escape.txt' resolves outside the root directory ${path.resolve(root)}.`,
    );
  });

  it('rejects an absolute path outside the root', async () => {
    const root = await tempDir();
    const outside = await tempDir();
    const target = path.join(outside, 'secret.txt');

    expect(() => resolveFilePath(target, root)).toThrow(
      'resolves outside the root directory',
    );
  });

  it('follows a symlink out of the root, which adk-python refuses', async () => {
    const root = await tempDir();
    const outside = await tempDir();
    // `junction` keeps this runnable on Windows, where a symlink needs a
    // privilege the test runner does not have.
    await fs.symlink(outside, path.join(root, 'esc'), 'junction');
    await fs.writeFile(path.join(outside, 'secret.txt'), 'TOKEN=abc');

    // The lexical check never reads the link, so the escape is allowed here.
    // Python's `Path.resolve()` follows it and raises. This pins the gap the
    // doc comment describes.
    expect(resolveFilePath('esc/secret.txt', root)).toBe(
      path.join(root, 'esc', 'secret.txt'),
    );
  });

  it('rejects a sibling directory that shares the root name prefix', async () => {
    const parent = await tempDir();
    const root = path.join(parent, 'agent');

    // `/tmp/agent` must not be treated as containing `/tmp/agent-evil/x`; a
    // `startsWith` check would wrongly allow this.
    expect(() => resolveFilePath('../agent-evil/x', root)).toThrow(
      'resolves outside the root directory',
    );
  });
});

describe('resolveFilePaths', () => {
  const tempDir = useTempDirs();

  it('preserves the input order', async () => {
    const root = await tempDir();

    expect(resolveFilePaths(['b.txt', 'a.txt', 'sub/c.txt'], root)).toEqual([
      path.join(root, 'b.txt'),
      path.join(root, 'a.txt'),
      path.join(root, 'sub', 'c.txt'),
    ]);
  });

  it('rejects the whole batch when one entry escapes', async () => {
    const root = await tempDir();

    expect(() =>
      resolveFilePaths(['ok.txt', '../escape.txt', 'also_ok.txt'], root),
    ).toThrow('resolves outside the root directory');
  });
});

describe('rootDirectoryFromContext', () => {
  it('returns the root directory held in the session state', () => {
    const context = createTestContext({root_directory: '/projects/demo'});

    expect(rootDirectoryFromContext(context)).toBe('/projects/demo');
  });

  it('returns "./" when there is no context', () => {
    expect(rootDirectoryFromContext()).toBe('./');
  });

  it('returns "./" when the state holds no root directory', () => {
    expect(rootDirectoryFromContext(createTestContext({}))).toBe('./');
  });

  it.each([[42], [''], [null], [{}]])(
    'returns "./" when the stored root is %j',
    (stored) => {
      const context = createTestContext({root_directory: stored});

      expect(rootDirectoryFromContext(context)).toBe('./');
    },
  );
});
