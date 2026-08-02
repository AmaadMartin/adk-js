/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import {File} from '../code_executors/code_execution_utils.js';

/**
 * Writes the given in-memory files to disk under a base directory, appending a
 * numeric suffix (`report.txt` -> `report_2.txt`) rather than overwriting an
 * existing file.
 *
 * Names that escape `dir` are rejected with a `Path traversal detected` error.
 * That check is a string-prefix comparison on the resolved path, not a
 * sandbox, and it is weaker than it looks: a sibling sharing the prefix
 * (`dir` of `/a/out` with the name `../out_leak.txt`) resolves to `/a/out_leak.txt`
 * and passes, and no lexical check survives symlinks, hardlinks, bind mounts
 * or a concurrent rename. Treat `dir` as a tidiness boundary, not a security
 * one, and do not point it at a directory whose siblings are sensitive.
 *
 * @param files The files to materialize.
 * @param dir Base directory to write under. Required: file names come from
 *     model- or script-controlled data, so the destination must be one the
 *     caller declared rather than the process working directory.
 * @returns The written files, with `name` rewritten to the final path relative
 *     to `dir`.
 */
export async function materializeFiles(
  files: File[],
  dir: string,
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

    let finalPath = fullPath;
    let counter = 2;

    while (true) {
      try {
        await fs.access(finalPath);
        // File exists, try next name
        const newName = `${base}_${counter}${ext}`;
        finalPath = path.join(dirName, newName);
        // Update file.name to reflect the actual relative path
        const originalDir = path.dirname(file.name);
        file.name =
          originalDir === '.' ? newName : path.join(originalDir, newName);
        counter++;
      } catch {
        // File does not exist, safe to write
        break;
      }
    }

    if (!finalPath.startsWith(resolvedBaseDir)) {
      throw new Error(
        `Path traversal detected: ${file.name} resolves outside of ${dir}`,
      );
    }

    await fs.mkdir(path.dirname(finalPath), {recursive: true});
    await fs.writeFile(
      finalPath,
      Buffer.from(file.content, file.contentEncoding),
    );

    createdFiles.push({
      ...file,
      name: path.relative(dir, finalPath),
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
