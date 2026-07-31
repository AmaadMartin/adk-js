/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import {File} from '../code_executors/code_execution_utils.js';

/**
 * Upper bound on the candidate names tried when resolving a filename
 * collision: the requested name, then `name_2` … `name_${this}`. Caps the
 * syscalls one file can cost in a directory that already holds many
 * same-named files.
 */
export const MAX_COLLISION_ATTEMPTS = 100;

function isFileExistsError(e: unknown): boolean {
  return (
    typeof e === 'object' && e !== null && 'code' in e && e.code === 'EEXIST'
  );
}

/**
 * Creates files with the given paths in the current working directory.
 *
 * The input `files` are never modified; the name each file was actually
 * written under is reported only through the returned array.
 *
 * @param files The files to materialize.
 * @returns Copies of `files` with `name` set to the path actually written,
 *     relative to `dir`.
 * @throws If a name resolves outside `dir`, or if every one of the
 *     {@link MAX_COLLISION_ATTEMPTS} candidate names for a file is taken.
 *     Either throw happens mid-way: files materialized for earlier entries
 *     stay on disk and are not rolled back.
 */
export async function materializeFiles(
  files: File[],
  dir = process.cwd(),
): Promise<File[]> {
  const resolvedBaseDir = path.resolve(dir);
  const createdFiles: File[] = [];
  for (const file of files) {
    const fullPath = path.resolve(dir, file.name);

    if (!fullPath.startsWith(resolvedBaseDir)) {
      throw new Error(
        `Path traversal detected: ${file.name} resolves outside of ${dir}`,
      );
    }

    const ext = path.extname(fullPath);
    const dirName = path.dirname(fullPath);
    const base = path.basename(fullPath, ext);
    const content = Buffer.from(file.content, file.contentEncoding);

    await fs.mkdir(dirName, {recursive: true});

    let writtenPath: string | undefined;

    for (let attempt = 0; attempt < MAX_COLLISION_ATTEMPTS; attempt++) {
      const candidatePath =
        attempt === 0
          ? fullPath
          : path.join(dirName, `${base}_${attempt + 1}${ext}`);

      if (!candidatePath.startsWith(resolvedBaseDir)) {
        throw new Error(
          `Path traversal detected: ${file.name} resolves outside of ${dir}`,
        );
      }

      try {
        // 'wx' claims the name atomically, so a writer that lost the race gets
        // EEXIST here instead of silently clobbering the winner. A directory
        // occupying the name also reports EEXIST, so it is suffixed past.
        await fs.writeFile(candidatePath, content, {flag: 'wx'});
        writtenPath = candidatePath;
        break;
      } catch (e: unknown) {
        if (!isFileExistsError(e)) {
          throw e;
        }
      }
    }

    if (writtenPath === undefined) {
      throw new Error(
        `Unable to materialize ${file.name}: all ${MAX_COLLISION_ATTEMPTS} ` +
          `candidate names are taken in ${dir}. Clean the directory or ` +
          `materialize into a different one.`,
      );
    }

    createdFiles.push({
      ...file,
      name: path.relative(dir, writtenPath),
    });
  }

  return createdFiles;
}

export const EXTENSION_TO_MIME_TYPE: Record<string, string> = {
  'pdf': 'application/pdf',
  'jpg': 'image/jpeg',
  'jpeg': 'image/jpeg',
  'png': 'image/png',
  'gif': 'image/gif',
  'csv': 'text/csv',
  'json': 'application/json',
  'xml': 'application/xml',
  'sh': 'text/x-shellscript',
  'bash': 'text/x-shellscript',
  'py': 'text/x-python',
  'js': 'text/javascript',
  'cjs': 'text/javascript',
  'mjs': 'text/javascript',
  'ts': 'text/javascript',
  'cts': 'text/javascript',
  'mts': 'text/javascript',
};

export function guessMimeType(filePath: string): string {
  const ext = filePath.split('.').pop()?.toLowerCase() || '';

  return EXTENSION_TO_MIME_TYPE[ext] || 'application/octet-stream';
}
