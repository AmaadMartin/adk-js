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
import {
  MAX_COLLISION_ATTEMPTS,
  materializeFiles,
} from '../../src/utils/file_utils.js';

// Only `writeFile` is mocked; it defaults to the real implementation (see
// `beforeEach`) so every other case still writes to a real temp directory.
const writeFileMock = vi.hoisted(() => vi.fn());
vi.mock('node:fs/promises', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:fs/promises')>()),
  writeFile: writeFileMock,
}));

const {writeFile: realWriteFile} =
  await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');

function textFile(name: string, content: string) {
  return {
    name,
    content,
    contentEncoding: FileContentEncoding.UTF8,
    mimeType: 'text/plain',
  };
}

describe('file_utils', () => {
  let tempDir: string;

  beforeEach(async () => {
    writeFileMock.mockReset();
    writeFileMock.mockImplementation(realWriteFile);
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

    it('should not mutate the input files when resolving a collision', async () => {
      const files = [
        textFile('collision.txt', 'first'),
        textFile('collision.txt', 'second'),
        textFile('sub/collision.txt', 'third'),
      ];
      const snapshot = structuredClone(files);

      const created = await materializeFiles(files, tempDir);

      expect(files).toEqual(snapshot);
      expect(created.map((file) => file.name)).toEqual([
        'collision.txt',
        'collision_2.txt',
        path.join('sub', 'collision.txt'),
      ]);
    });

    it('should not mutate the input file when the name resolves outside the target directory', async () => {
      const files = [textFile('../escape.txt', 'dangerous')];
      const snapshot = structuredClone(files);

      await expect(materializeFiles(files, tempDir)).rejects.toThrow(
        /Path traversal detected/,
      );
      expect(files).toEqual(snapshot);
    });

    it('should throw once the collision attempt cap is exhausted', async () => {
      const taken = [
        'cap.txt',
        ...Array.from(
          {length: MAX_COLLISION_ATTEMPTS - 1},
          (_unused, index) => `cap_${index + 2}.txt`,
        ),
      ];
      await Promise.all(
        taken.map((name) => fs.writeFile(path.join(tempDir, name), 'taken')),
      );
      const files = [textFile('cap.txt', 'overflow')];
      const snapshot = structuredClone(files);

      await expect(materializeFiles(files, tempDir)).rejects.toThrow(
        new RegExp(`cap\\.txt.*${MAX_COLLISION_ATTEMPTS} candidate names`),
      );
      expect(files).toEqual(snapshot);
      await expect(
        fs.access(path.join(tempDir, `cap_${MAX_COLLISION_ATTEMPTS + 1}.txt`)),
      ).rejects.toThrow();
    });

    it('should keep both payloads when two calls materialize the same name concurrently', async () => {
      const [firstCreated, secondCreated] = await Promise.all([
        materializeFiles([textFile('race.txt', 'a-content')], tempDir),
        materializeFiles([textFile('race.txt', 'b-content')], tempDir),
      ]);

      expect(firstCreated[0].name).not.toBe(secondCreated[0].name);

      const written = await fs.readdir(tempDir);
      expect(written).toHaveLength(2);
      const contents = await Promise.all(
        written.map((name) => fs.readFile(path.join(tempDir, name), 'utf8')),
      );
      expect(new Set(contents)).toEqual(new Set(['a-content', 'b-content']));
    });

    it('should suffix past a directory occupying the target name', async () => {
      await fs.mkdir(path.join(tempDir, 'collision.txt'));

      const created = await materializeFiles(
        [textFile('collision.txt', 'hello')],
        tempDir,
      );

      expect(created[0].name).toBe('collision_2.txt');
      expect(
        await fs.readFile(path.join(tempDir, 'collision_2.txt'), 'utf8'),
      ).toBe('hello');
    });

    it('should throw when the parent of the resolved name is outside the target directory', async () => {
      // '.' resolves onto the base directory itself, so its parent -- and
      // therefore every collision candidate -- sits outside the base directory.
      const baseDir = path.join(tempDir, 'inner', 'nested.txt');

      await expect(
        materializeFiles([textFile('.', 'dangerous')], baseDir),
      ).rejects.toThrow(/Path traversal detected/);
      // Nothing was created outside the base directory before the throw.
      await expect(fs.access(path.join(tempDir, 'inner'))).rejects.toThrow();
    });

    it('should propagate a write failure that is not a name collision', async () => {
      writeFileMock.mockRejectedValueOnce(
        Object.assign(new Error('permission denied'), {code: 'EACCES'}),
      );

      await expect(
        materializeFiles([textFile('denied.txt', 'hello')], tempDir),
      ).rejects.toThrow('permission denied');
      expect(writeFileMock).toHaveBeenCalledTimes(1);
    });
  });
});
