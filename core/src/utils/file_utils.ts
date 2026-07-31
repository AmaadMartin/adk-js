/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import {File} from '../code_executors/code_execution_utils.js';

/**
 * Creates files with the given paths in the current working directory.
 * @param files The files to materialize.
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

/**
 * Validates and resolves a path against a base working directory, ensuring
 * that the resolved path does not escape the working directory.
 *
 * The check is lexical: `path.resolve` and `path.relative` normalize `..`
 * segments but never touch the filesystem, so a symlink stored inside
 * `workingDir` that points elsewhere still resolves to a path outside it. That
 * is deliberate -- reading through symlinks is normal and necessary for real
 * workspace layouts, such as the package links npm creates under
 * `node_modules`. This guards against traversal in the *argument*; it is not a
 * sandbox, and callers who need one should point at an isolated filesystem.
 *
 * @param workingDir The base working directory.
 * @param relativeOrAbsolutePath The path to check.
 * @return The resolved absolute path.
 */
export function resolveAndValidatePath(
  workingDir: string,
  relativeOrAbsolutePath: string,
): string {
  // If it's absolute, check it directly. Otherwise resolve relative to
  // workingDir.
  const resolvedWorkingDir = path.resolve(workingDir);
  const resolvedPath = path.resolve(resolvedWorkingDir, relativeOrAbsolutePath);
  const relative = path.relative(resolvedWorkingDir, resolvedPath);

  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(
      `Path ${relativeOrAbsolutePath} escapes the working directory.`,
    );
  }
  return resolvedPath;
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
