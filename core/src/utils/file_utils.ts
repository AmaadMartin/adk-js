/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import {File} from '../code_executors/code_execution_utils.js';
import {getMimeTypeAndEncoding} from './file_extension_utils.js';

/**
 * Reports whether `fullPath` is a strict descendant of `baseDir`. Both
 * arguments must already be resolved absolute paths.
 *
 * A plain `fullPath.startsWith(baseDir)` check is a path-separator-unaware
 * prefix match: it also accepts sibling directories whose name merely starts
 * with the same string, e.g. base dir `/tmp/agent` wrongly "contains"
 * `/tmp/agent-evil/x`. A relative path with no `..` segment closes that gap.
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
 * @param dir Base directory to write under.
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

/**
 * Guesses the MIME type of a file from its extension.
 * @param filePath A file name or path.
 * @returns The MIME type, or 'application/octet-stream' if the extension is
 *     unknown or absent.
 */
export function guessMimeType(filePath: string): string {
  return getMimeTypeAndEncoding(path.extname(filePath)).mimeType;
}
