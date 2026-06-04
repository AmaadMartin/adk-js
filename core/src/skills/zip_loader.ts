/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import JSZip from 'jszip';
import {isUtf8} from 'node:buffer';
import {parseSkillMdContent} from './loader.js';
import {Resources, Script, Skill} from './skill.js';

/**
 * Finds a unique common top-level directory prefix if there is one.
 */
function findCommonRootPrefix(zip: JSZip): string {
  const fileNames = Object.keys(zip.files).filter(
    (name) => !zip.files[name].dir,
  );
  if (fileNames.length === 0) return '';

  const firstParts = fileNames.map((name) => name.split('/')[0]);
  const uniqueFirstParts = new Set(firstParts);

  if (uniqueFirstParts.size === 1) {
    const root = Array.from(uniqueFirstParts)[0];
    if (fileNames.every((name) => name.startsWith(root + '/'))) {
      return root + '/';
    }
  }
  return '';
}

/**
 * Loads a complete skill directly from in-memory zip file bytes.
 *
 * @param zipBytes - The raw bytes of the zip file containing the skill.
 * @returns A promise that resolves to the fully loaded Skill object.
 * @throws {Error} If SKILL.md is not found, or contains dangerous paths.
 */
export async function loadSkillFromZipBytes(zipBytes: Buffer): Promise<Skill> {
  const zip = await JSZip.loadAsync(zipBytes);

  // Security check for zip slip
  for (const filename of Object.keys(zip.files)) {
    if (
      filename.startsWith('/') ||
      filename.startsWith('../') ||
      filename.includes('/../')
    ) {
      throw new Error(`Dangerous zip entry ignored: ${filename}`);
    }
  }

  const commonPrefix = findCommonRootPrefix(zip);

  let skillMdContent: string | null = null;
  for (const name of ['SKILL.md', 'skill.md']) {
    const entry = zip.file(commonPrefix + name);
    if (entry) {
      skillMdContent = await entry.async('string');
      break;
    }
  }

  if (skillMdContent === null) {
    throw new Error('SKILL.md not found in zipped filesystem.');
  }

  const {frontmatter, body} = parseSkillMdContent(skillMdContent);

  // Helper to load files under a directory prefix inside the zip
  const loadZipDir = async (
    dirName: string,
  ): Promise<Record<string, string | Buffer>> => {
    const result: Record<string, string | Buffer> = {};
    const prefix = commonPrefix + dirName + '/';

    for (const [filename, file] of Object.entries(zip.files)) {
      if (file.dir) {
        continue;
      }
      if (filename.startsWith(prefix)) {
        if (filename.includes('__pycache__')) {
          continue;
        }
        const relativePath = filename.substring(prefix.length);
        if (relativePath) {
          const buffer = await file.async('nodebuffer');
          if (isUtf8(buffer)) {
            result[relativePath] = buffer.toString('utf-8');
          } else {
            result[relativePath] = buffer;
          }
        }
      }
    }
    return result;
  };

  const [references, assets, rawScripts] = await Promise.all([
    loadZipDir('references'),
    loadZipDir('assets'),
    loadZipDir('scripts'),
  ]);

  const scripts: Record<string, Script> = {};
  for (const [name, src] of Object.entries(rawScripts)) {
    if (typeof src === 'string') {
      scripts[name] = {src};
    }
  }

  const resources: Resources = {references, assets, scripts};

  return {
    frontmatter,
    instructions: body,
    resources,
  };
}
