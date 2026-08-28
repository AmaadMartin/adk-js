/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {loadTextChunks} from '@google/adk';
import {
  chunkText,
  DEFAULT_CHUNK_OVERLAP,
  DEFAULT_CHUNK_SIZE,
} from '@google/adk/tools/retrieval/document_loader.js';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';

/** Symbolic links and file permissions do not behave the same on Windows. */
const onPosix = process.platform !== 'win32';

/** A process running as root reads a file whose mode denies every user. */
const asNonRoot = process.getuid === undefined || process.getuid() !== 0;

let inputDir: string;

beforeEach(async () => {
  inputDir = await fs.mkdtemp(
    path.join(os.tmpdir(), 'adk-files-retrieval-test-'),
  );
});

afterEach(async () => {
  await fs.rm(inputDir, {recursive: true, force: true});
});

async function writeFile(
  relativePath: string,
  contents: string | Buffer,
): Promise<string> {
  const filePath = path.join(inputDir, relativePath);
  await fs.mkdir(path.dirname(filePath), {recursive: true});
  await fs.writeFile(filePath, contents);
  return filePath;
}

describe('chunkText', () => {
  it('yields one chunk for text shorter than the chunk size', () => {
    expect(chunkText('short', 10, 4)).toEqual(['short']);
  });

  it('yields no chunk for empty text', () => {
    expect(chunkText('', 10, 4)).toEqual([]);
  });

  it('makes consecutive chunks share the overlap', () => {
    const chunks = chunkText('abcdefghijklmnopqrst', 10, 4);

    expect(chunks).toEqual(['abcdefghij', 'ghijklmnop', 'mnopqrst']);
  });

  it('stops once a chunk reaches the end of the text', () => {
    // The window advances by 6, so a 16th character would start a fourth
    // chunk holding nothing but the overlap.
    expect(chunkText('abcdefghijklmnop', 10, 4)).toEqual([
      'abcdefghij',
      'ghijklmnop',
    ]);
  });

  it('rejects an overlap that is not smaller than the chunk size', () => {
    expect(() => chunkText('abc', 10, 10)).toThrow(
      'Chunk overlap 10 must be smaller than chunk size 10.',
    );
  });

  it('splits on the documented defaults', () => {
    const chunks = chunkText('a'.repeat(DEFAULT_CHUNK_SIZE + 1));

    expect(chunks[0]).toHaveLength(DEFAULT_CHUNK_SIZE);
    expect(chunks[1]).toHaveLength(DEFAULT_CHUNK_OVERLAP + 1);
  });
});

describe('loadTextChunks', () => {
  it('reads nested directories, in path order', async () => {
    await writeFile(path.join('b_second.txt'), 'second file');
    await writeFile(path.join('a_nested', 'deep.txt'), 'nested file');

    const chunks = await loadTextChunks(inputDir);

    expect(chunks.map((chunk) => chunk.text)).toEqual([
      'nested file',
      'second file',
    ]);
  });

  it('tags every chunk with the file it came from', async () => {
    const filePath = await writeFile('notes.txt', 'abcdefghijklmnop');

    const chunks = await loadTextChunks(inputDir, {
      chunkSize: 10,
      chunkOverlap: 4,
    });

    expect(chunks).toEqual([
      {text: 'abcdefghij', sourcePath: filePath},
      {text: 'ghijklmnop', sourcePath: filePath},
    ]);
  });

  it('skips a binary file', async () => {
    await writeFile('image.bin', Buffer.from([0xff, 0xfe, 0xff]));
    await writeFile('notes.txt', 'readable');

    const chunks = await loadTextChunks(inputDir);

    expect(chunks.map((chunk) => chunk.text)).toEqual(['readable']);
  });

  it('skips a blank file', async () => {
    await writeFile('blank.txt', '   \n  ');
    await writeFile('notes.txt', 'readable');

    const chunks = await loadTextChunks(inputDir);

    expect(chunks.map((chunk) => chunk.text)).toEqual(['readable']);
  });

  it.skipIf(!onPosix)('skips a symbolic link', async () => {
    await writeFile('notes.txt', 'readable');
    await fs.symlink(
      path.join(inputDir, 'notes.txt'),
      path.join(inputDir, 'link.txt'),
    );

    const chunks = await loadTextChunks(inputDir);

    expect(chunks.map((chunk) => chunk.sourcePath)).toEqual([
      path.join(inputDir, 'notes.txt'),
    ]);
  });

  it.skipIf(!onPosix || !asNonRoot)('skips a file it cannot read', async () => {
    const denied = await writeFile('denied.txt', 'unreadable');
    await fs.chmod(denied, 0o000);
    await writeFile('notes.txt', 'readable');

    const chunks = await loadTextChunks(inputDir);

    expect(chunks.map((chunk) => chunk.text)).toEqual(['readable']);
  });

  it('rejects a directory that does not exist', async () => {
    const missing = path.join(inputDir, 'missing');

    await expect(loadTextChunks(missing)).rejects.toThrow(
      `Input directory does not exist: ${missing}`,
    );
  });

  it('rejects a path that is a file', async () => {
    const filePath = await writeFile('notes.txt', 'readable');

    await expect(loadTextChunks(filePath)).rejects.toThrow(
      `Input directory does not exist: ${filePath}`,
    );
  });

  it('propagates a stat failure that is not a missing directory', async () => {
    // A null byte makes Node reject the path itself, so `stat` fails with
    // something other than ENOENT.
    await expect(loadTextChunks('bad\u0000path')).rejects.toThrow(/null bytes/);
  });

  it('returns nothing for a directory that holds nothing to index', async () => {
    expect(await loadTextChunks(inputDir)).toEqual([]);
  });
});
