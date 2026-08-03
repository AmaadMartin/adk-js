/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import {File} from '../code_executors/code_execution_utils.js';

/**
 * Reports whether `fullPath` is a strict descendant of `baseDir`. Both
 * arguments must already be resolved absolute paths.
 */
function isContained(baseDir: string, fullPath: string): boolean {
  const rel = path.relative(baseDir, fullPath);

  return (
    rel !== '' && !path.isAbsolute(rel) && !rel.split(path.sep).includes('..')
  );
}

/**
 * Writes the given in-memory files under `dir`, creating parent directories as
 * needed. An existing file is never overwritten: a numeric suffix is appended
 * instead (`report.txt` -> `report_2.txt` -> `report_3.txt`).
 *
 * A name that does not resolve to a strict descendant of `dir` is rejected with
 * a `Path traversal detected` error. That containment check is a lexical
 * comparison of resolved paths and is **not** a sandbox: it does not survive
 * symlinks, hardlinks, bind mounts, or a TOCTOU race between the check and the
 * write.
 *
 * @param files The files to materialize. `name` is updated in place when a
 *     collision forces a rename.
 * @param dir Base directory to write under. Required rather than defaulted:
 *     file names originate from script- or model-controlled data, and an
 *     implicit default writes them into whichever directory the host process
 *     happened to be launched from.
 * @returns The written files, each `name` rewritten to the final path relative
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

    if (!isContained(resolvedBaseDir, fullPath)) {
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

    if (!isContained(resolvedBaseDir, finalPath)) {
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
