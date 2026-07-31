/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {FileContentEncoding} from '@google/adk';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {materializeFiles} from '../../src/utils/file_utils.js';

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

      await materializeFiles(files, tempDir);

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
    });

    it('should default the base directory to the working directory of each call', async () => {
      // Callers that omit `dir` — the skill script tools when no output
      // directory is configured — follow process.cwd() as of the call, not as
      // of module load, so a process that chdir()s is tracked.
      const secondDir = await fs.mkdtemp(
        path.join(os.tmpdir(), 'file_utils_test_second_'),
      );
      const newFile = () => [
        {
          name: 'default_dir.txt',
          content: 'hello',
          contentEncoding: FileContentEncoding.UTF8,
          mimeType: 'text/plain',
        },
      ];
      const cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(tempDir);

      try {
        const first = await materializeFiles(newFile());
        expect(first[0].name).toBe('default_dir.txt');

        cwdSpy.mockReturnValue(secondDir);
        await materializeFiles(newFile());

        // Written under the cwd in effect at each call, not a single snapshot
        // (a snapshot would have collided and produced default_dir_2.txt).
        expect(
          await fs.readFile(path.join(tempDir, 'default_dir.txt'), 'utf8'),
        ).toBe('hello');
        expect(
          await fs.readFile(path.join(secondDir, 'default_dir.txt'), 'utf8'),
        ).toBe('hello');
      } finally {
        cwdSpy.mockRestore();
        await fs.rm(secondDir, {recursive: true, force: true});
      }
    });

    it('should create the target directory when it does not exist', async () => {
      // What a configured `outputDir` relies on: the operator names a
      // directory, the first write brings it into existence.
      const missingDir = path.join(tempDir, 'nested', 'out');
      const files = [
        {
          name: 'created.txt',
          content: 'hello',
          contentEncoding: FileContentEncoding.UTF8,
          mimeType: 'text/plain',
        },
      ];

      const written = await materializeFiles(files, missingDir);

      expect(written[0].name).toBe('created.txt');
      const content = await fs.readFile(
        path.join(missingDir, 'created.txt'),
        'utf8',
      );
      expect(content).toBe('hello');
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
  });
});
