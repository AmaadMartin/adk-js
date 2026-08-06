/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {File, FileContentEncoding} from '@google/adk';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {materializeFiles} from '../../src/utils/file_utils.js';

/** Absolute win32 directory the simulated Windows tests materialize into. */
const WIN_DIR = 'C:\\work';

describe('file_utils', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'file_utils_test_'));
  });

  afterEach(async () => {
    await fs.rm(tempDir, {recursive: true, force: true});
  });

  describe('materializeFiles', () => {
    it('should materialize files within the target directory', async () => {
      const files = [
        {
          name: 'test.txt',
          content: 'hello',
          contentEncoding: FileContentEncoding.UTF8,
          mimeType: 'text/plain',
        },
        {
          name: 'sub/test2.txt',
          content: 'world',
          contentEncoding: FileContentEncoding.UTF8,
          mimeType: 'text/plain',
        },
      ];

      const created = await materializeFiles(files, tempDir);

      const content1 = await fs.readFile(
        path.join(tempDir, 'test.txt'),
        'utf8',
      );
      expect(content1).toBe('hello');

      const content2 = await fs.readFile(
        path.join(tempDir, 'sub/test2.txt'),
        'utf8',
      );
      expect(content2).toBe('world');

      expect(created.map((f) => f.name)).toEqual(['test.txt', 'sub/test2.txt']);
    });

    it('should throw an error if file attempts to escape target directory via relative path', async () => {
      const files = [
        {
          name: '../escape.txt',
          content: 'dangerous',
          contentEncoding: FileContentEncoding.UTF8,
          mimeType: 'text/plain',
        },
      ];

      await expect(materializeFiles(files, tempDir)).rejects.toThrow(
        /Path traversal detected/,
      );
    });

    it('should throw an error if file attempts to escape into a sibling directory sharing a name prefix', async () => {
      // A plain `resolvedPath.startsWith(resolvedBaseDir)` check is fooled by a
      // sibling directory whose name merely starts with the same string as the
      // target directory (e.g. target `.../sandbox` vs sibling
      // `.../sandbox-evil`), since it never requires a path-separator boundary.
      const siblingName = `${path.basename(tempDir)}-evil`;
      const files = [
        {
          name: `../${siblingName}/escape.txt`,
          content: 'dangerous',
          contentEncoding: FileContentEncoding.UTF8,
          mimeType: 'text/plain',
        },
      ];

      await expect(materializeFiles(files, tempDir)).rejects.toThrow(
        /Path traversal detected/,
      );

      const siblingPath = path.join(path.dirname(tempDir), siblingName);
      await expect(fs.access(siblingPath)).rejects.toThrow();
    });

    it('should throw an error if file attempts to escape target directory via absolute path', async () => {
      const outsidePath = path.resolve(tempDir, '../outside.txt');
      const files = [
        {
          name: outsidePath,
          content: 'dangerous',
          contentEncoding: FileContentEncoding.UTF8,
          mimeType: 'text/plain',
        },
      ];

      await expect(materializeFiles(files, tempDir)).rejects.toThrow(
        /Path traversal detected/,
      );
    });

    it('should allow relative paths that stay within the target directory', async () => {
      const files = [
        {
          name: './test.txt',
          content: 'hello',
          contentEncoding: FileContentEncoding.UTF8,
          mimeType: 'text/plain',
        },
        {
          name: 'sub/../test2.txt',
          content: 'world',
          contentEncoding: FileContentEncoding.UTF8,
          mimeType: 'text/plain',
        },
      ];

      await materializeFiles(files, tempDir);

      const content1 = await fs.readFile(
        path.join(tempDir, 'test.txt'),
        'utf8',
      );
      expect(content1).toBe('hello');

      const content2 = await fs.readFile(
        path.join(tempDir, 'test2.txt'),
        'utf8',
      );
      expect(content2).toBe('world');
    });

    it('should append a numeric suffix to the filename if it already exists', async () => {
      const files = [
        {
          name: 'collision.txt',
          content: 'first',
          contentEncoding: FileContentEncoding.UTF8,
          mimeType: 'text/plain',
        },
        {
          name: 'collision.txt',
          content: 'second',
          contentEncoding: FileContentEncoding.UTF8,
          mimeType: 'text/plain',
        },
        {
          name: 'collision.txt',
          content: 'third',
          contentEncoding: FileContentEncoding.UTF8,
          mimeType: 'text/plain',
        },
      ];

      await materializeFiles(files, tempDir);

      const content1 = await fs.readFile(
        path.join(tempDir, 'collision.txt'),
        'utf8',
      );
      expect(content1).toBe('first');

      const content2 = await fs.readFile(
        path.join(tempDir, 'collision_2.txt'),
        'utf8',
      );
      expect(content2).toBe('second');

      const content3 = await fs.readFile(
        path.join(tempDir, 'collision_3.txt'),
        'utf8',
      );
      expect(content3).toBe('third');
    });

    describe('on a Windows host', () => {
      /** Absolute win32 paths that `fs.access` reports as already existing. */
      let existingPaths: Set<string>;

      /**
       * Re-imports file_utils with `node:path` bound to win32 and the
       * filesystem stubbed, so the Windows separator behaviour can be pinned
       * on a POSIX runner. The test file's own top-level `node:path` and
       * `node:fs/promises` imports are already resolved and stay real.
       */
      async function loadMaterializeFiles() {
        vi.resetModules();
        vi.doMock('node:path', async () => {
          const actual =
            await vi.importActual<typeof import('node:path')>('node:path');
          return {...actual.win32, default: actual.win32};
        });
        vi.doMock('node:fs/promises', () => {
          const impl = {
            access: async (p: string) => {
              if (!existingPaths.has(p)) {
                throw new Error(`ENOENT: ${p}`);
              }
            },
            mkdir: async () => undefined,
            writeFile: async () => undefined,
          };
          return {...impl, default: impl};
        });
        return (await import('../../src/utils/file_utils.js')).materializeFiles;
      }

      function nestedFile(): File {
        return {
          name: 'sub/test2.txt',
          content: 'world',
          contentEncoding: FileContentEncoding.UTF8,
          mimeType: 'text/plain',
        };
      }

      beforeEach(() => {
        existingPaths = new Set<string>();
      });

      afterEach(() => {
        vi.doUnmock('node:path');
        vi.doUnmock('node:fs/promises');
        vi.resetModules();
      });

      it('returns a nested name with forward slashes, not the host separator', async () => {
        const materializeFilesWin32 = await loadMaterializeFiles();

        const created = await materializeFilesWin32([nestedFile()], WIN_DIR);

        expect(created.map((f) => f.name)).toEqual(['sub/test2.txt']);
      });

      it('returns a nested collision-renamed name with forward slashes', async () => {
        existingPaths.add('C:\\work\\sub\\test2.txt');
        const materializeFilesWin32 = await loadMaterializeFiles();

        const created = await materializeFilesWin32([nestedFile()], WIN_DIR);

        expect(created.map((f) => f.name)).toEqual(['sub/test2_2.txt']);
      });

      it('rewrites the input name with forward slashes on a nested collision', async () => {
        existingPaths.add('C:\\work\\sub\\test2.txt');
        const materializeFilesWin32 = await loadMaterializeFiles();
        const files = [nestedFile()];

        await materializeFilesWin32(files, WIN_DIR);

        expect(files.map((f) => f.name)).toEqual(['sub/test2_2.txt']);
      });

      it('leaves a top-level collision name unchanged', async () => {
        existingPaths.add('C:\\work\\test.txt');
        const materializeFilesWin32 = await loadMaterializeFiles();
        const files: File[] = [
          {
            name: 'test.txt',
            content: 'hello',
            contentEncoding: FileContentEncoding.UTF8,
            mimeType: 'text/plain',
          },
        ];

        const created = await materializeFilesWin32(files, WIN_DIR);

        expect(created.map((f) => f.name)).toEqual(['test_2.txt']);
        expect(files.map((f) => f.name)).toEqual(['test_2.txt']);
      });
    });
  });
});
