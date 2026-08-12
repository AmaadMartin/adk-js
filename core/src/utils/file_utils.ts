/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import {
  File,
  FileContentEncoding,
} from '../code_executors/code_execution_utils.js';

/**
 * Decodes a file's content into its raw bytes.
 *
 * `contentEncoding` is optional, and an absent value means
 * `FileContentEncoding.BASE64`: `File` is the only representation of a binary
 * payload in the code-executor API, and arbitrary bytes do not survive being
 * read back as text. Every producer in this package sets the field
 * explicitly, so the default applies only to externally built files.
 */
export function decodeFileContent(file: File): Buffer {
  return Buffer.from(
    file.content,
    file.contentEncoding ?? FileContentEncoding.BASE64,
  );
}

/**
 * Reports whether resolvedPath is resolvedBaseDir itself, or a path nested
 * inside it.
 *
 * A plain `resolvedPath.startsWith(resolvedBaseDir)` check is a path-separator-
 * unaware prefix match: it also accepts sibling directories whose name merely
 * starts with the same string, e.g. base dir `/tmp/agent` wrongly "contains"
 * `/tmp/agent-evil/x`. Requiring the trailing separator (or exact equality)
 * closes that gap.
 */
function isInsideDir(resolvedPath: string, resolvedBaseDir: string): boolean {
  return (
    resolvedPath === resolvedBaseDir ||
    resolvedPath.startsWith(resolvedBaseDir + path.sep)
  );
}

/**
 * Creates files with the given paths in the current working directory.
 * @param files The files to materialize. Each file is written as the bytes
 *     {@link decodeFileContent} decodes its content into.
 */
export async function materializeFiles(
  files: File[],
  dir = process.cwd(),
): Promise<File[]> {
  const resolvedBaseDir = path.resolve(dir);
  const createdFiles: File[] = [];
  for (const file of files) {
    const fullPath = path.resolve(dir, file.name);

    if (!isInsideDir(fullPath, resolvedBaseDir)) {
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

    if (!isInsideDir(finalPath, resolvedBaseDir)) {
      throw new Error(
        `Path traversal detected: ${file.name} resolves outside of ${dir}`,
      );
    }

    await fs.mkdir(path.dirname(finalPath), {recursive: true});
    await fs.writeFile(finalPath, decodeFileContent(file));

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
