/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as crypto from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

/** Check if the given folder exists. */
export async function isFolderExists(folderPath: string): Promise<boolean> {
  try {
    await fs.access(folderPath);
    const stat = await fs.stat(folderPath);

    return stat.isDirectory();
  } catch (_e: unknown) {
    return false;
  }
}

/** Check if the given file exists. */
export async function isFileExists(folderPath: string): Promise<boolean> {
  try {
    const stat = await fs.stat(folderPath);

    return stat.isFile();
  } catch (_e: unknown) {
    return false;
  }
}

/** Create a new folder at the specific path */
export async function createFolder(folderPath: string): Promise<void> {
  try {
    await fs.mkdir(folderPath);
  } catch (e) {
    console.error(`Failed to create folder ${folderPath}`, e);
  }
}

/** Remove a folder at the specified location */
export async function removeFolder(folderPath: string): Promise<void> {
  try {
    await fs.rm(folderPath, {recursive: true});
  } catch (e) {
    console.error(`Failed to remove folder ${folderPath}`, e);
  }
}

/** List files within a directory */
export async function listFiles(folderPath: string): Promise<string[]> {
  try {
    return await fs.readdir(folderPath);
  } catch (e) {
    console.error(`Failed to list files in folder ${folderPath}`, e);

    return [];
  }
}

/** Check if the given path is a file. */
export async function isFile(filePath: string): Promise<boolean> {
  try {
    const stat = await fs.stat(filePath);
    return stat.isFile();
  } catch (_e: unknown) {
    return false;
  }
}

/** Load data from a file in JSON format. */
export async function loadFileData<T>(
  filePath: string,
): Promise<T | undefined> {
  try {
    return JSON.parse(await fs.readFile(filePath, {encoding: 'utf-8'})) as T;
  } catch (e) {
    console.error(`Failed to read or parse file ${filePath}:`, e);

    throw e;
  }
}

/** Save data to a file in JSON format. */
export async function saveToFile<T>(filePath: string, data: T): Promise<void> {
  try {
    await fs.writeFile(
      filePath,
      typeof data === 'string' ? data : JSON.stringify(data, null, 2),
      {encoding: 'utf-8'},
    );
  } catch (e) {
    console.error(`Failed to write file ${filePath}:`, e);

    throw e;
  }
}

/**
 * Return a temporary directory path.
 * @param prefix Optional prefix for the temp directory
 * @returns
 */
export function getTempDir(prefix?: string): string {
  const pathParts = [os.tmpdir()];

  if (prefix) {
    pathParts.push(prefix);
  }

  pathParts.push(crypto.randomUUID());

  return path.join(...pathParts);
}

/** Walk `sourceFolder` and its ancestors looking for an entry named `entryName`. */
async function tryToFindEntryRecursively(
  sourceFolder: string,
  entryName: string,
  maxIterations: number,
  exists: (entryPath: string) => Promise<boolean>,
): Promise<string> {
  let currentFolder = sourceFolder;

  for (let i = 0; i < maxIterations; i++) {
    const entryPath = path.join(currentFolder, entryName);

    if (await exists(entryPath)) {
      return entryPath;
    }

    currentFolder = path.dirname(currentFolder);
  }

  throw new Error(
    `No ${entryName} found in ${
      sourceFolder
    } or its parent folders up to ${maxIterations} levels.`,
  );
}

/**
 * Try to find a file recursively in the given folder.
 * @param sourceFolder The folder to search in.
 * @param fileName The name of the file to find.
 * @param maxIterations The maximum number of iterations to perform.
 * @returns The absolute path of the found file.
 * @throws Error if the file is not found after the maximum number of
 *     iterations.
 */
export async function tryToFindFileRecursively(
  sourceFolder: string,
  fileName: string,
  maxIterations: number,
): Promise<string> {
  return tryToFindEntryRecursively(
    sourceFolder,
    fileName,
    maxIterations,
    isFileExists,
  );
}

/**
 * Try to find a folder recursively in the given folder.
 *
 * Directories named `folderName` match; a plain file with the same name does
 * not, and the walk continues into the parent folder.
 * @param sourceFolder The folder to search in.
 * @param folderName The name of the folder to find.
 * @param maxIterations The maximum number of iterations to perform.
 * @returns The absolute path of the found folder.
 * @throws Error if the folder is not found after the maximum number of
 *     iterations.
 */
export async function tryToFindFolderRecursively(
  sourceFolder: string,
  folderName: string,
  maxIterations: number,
): Promise<string> {
  return tryToFindEntryRecursively(
    sourceFolder,
    folderName,
    maxIterations,
    isFolderExists,
  );
}
