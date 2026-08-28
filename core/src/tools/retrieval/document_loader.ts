/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {isUtf8} from 'node:buffer';
import {Stats} from 'node:fs';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import {logger} from '../../utils/logger.js';

/**
 * Characters per chunk. llama-index splits on the same number of tokens, so a
 * chunk here holds less text than a llama-index chunk of the same setting.
 */
export const DEFAULT_CHUNK_SIZE = 1024;

/** Characters two neighbouring chunks share. */
export const DEFAULT_CHUNK_OVERLAP = 200;

function isFileNotFoundError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === 'ENOENT'
  );
}

async function statOrUndefined(target: string): Promise<Stats | undefined> {
  try {
    return await fs.stat(target);
  } catch (error: unknown) {
    if (isFileNotFoundError(error)) {
      return undefined;
    }
    throw error;
  }
}

/**
 * Splits text into fixed-size windows that advance by `chunkSize - overlap`.
 *
 * Text shorter than `chunkSize` yields exactly one chunk, and no chunk is
 * empty.
 */
export function chunkText(
  text: string,
  chunkSize: number = DEFAULT_CHUNK_SIZE,
  overlap: number = DEFAULT_CHUNK_OVERLAP,
): string[] {
  if (overlap >= chunkSize) {
    throw new Error(
      `Chunk overlap ${overlap} must be smaller than chunk size ${chunkSize}.`,
    );
  }

  const chunks: string[] = [];
  for (let start = 0; start < text.length; start += chunkSize - overlap) {
    chunks.push(text.slice(start, start + chunkSize));
    if (start + chunkSize >= text.length) {
      break;
    }
  }
  return chunks;
}

/**
 * Reads `filePath` as UTF-8 text, or returns undefined when it holds nothing
 * to index.
 *
 * A file is skipped when it is binary, when it is blank, or when the process
 * cannot read it. One such file must not fail a whole index build.
 */
async function readTextFile(filePath: string): Promise<string | undefined> {
  let data: Buffer;
  try {
    data = await fs.readFile(filePath);
  } catch (error: unknown) {
    logger.debug(`Skipping unreadable file ${filePath}:`, error);
    return undefined;
  }

  if (!isUtf8(data)) {
    logger.debug(`Skipping binary file ${filePath}`);
    return undefined;
  }

  const text = data.toString('utf-8');
  if (text.trim() === '') {
    logger.debug(`Skipping blank file ${filePath}`);
    return undefined;
  }
  return text;
}

/**
 * Lists every regular file under `dir`, recursing into subdirectories.
 *
 * A symbolic link is neither a file nor a directory to `readdir`, so links are
 * skipped and the walk cannot follow one out of `dir` or into a cycle.
 */
async function collectFilePaths(dir: string): Promise<string[]> {
  const entries = await fs.readdir(dir, {withFileTypes: true});
  const filePaths: string[] = [];
  for (const entry of entries) {
    const entryPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      filePaths.push(...(await collectFilePaths(entryPath)));
    } else if (entry.isFile()) {
      filePaths.push(entryPath);
    }
  }
  return filePaths;
}

/**
 * Reads every UTF-8 text file under `inputDir` and splits it into chunks.
 *
 * Only plain text is indexed. llama-index reads PDF and Office documents
 * through reader plugins; this loader has no such readers, so those files are
 * skipped as binary.
 *
 * Paths are sorted before reading, so the returned order is the same on every
 * platform.
 *
 * @param inputDir The directory to read.
 * @return The chunks, in path order and then in file order.
 */
export async function loadTextChunks(inputDir: string): Promise<string[]> {
  const stats = await statOrUndefined(inputDir);
  if (!stats?.isDirectory()) {
    throw new Error(`Input directory does not exist: ${inputDir}`);
  }

  const filePaths = (await collectFilePaths(inputDir)).sort();
  const chunks: string[] = [];
  for (const filePath of filePaths) {
    const text = await readTextFile(filePath);
    if (text === undefined) {
      continue;
    }
    chunks.push(...chunkText(text));
  }
  return chunks;
}
