/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  loadAllSkillsInDir,
  loadSkillFromDir,
  loadSkillFromZipBuffer,
} from '@google/adk';
import AdmZip from 'adm-zip';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {pathToFileURL} from 'node:url';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';

const SKILL_MD = `---
name: uri-skill
description: A skill loaded from a directory
---
Body content.`;

describe('skill source uri', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'adk-skill-uri-'));
  });

  afterEach(async () => {
    await fs.rm(tempDir, {recursive: true, force: true});
  });

  it('names the directory a skill was loaded from', async () => {
    const skillDir = path.join(tempDir, 'uri-skill');
    await fs.mkdir(skillDir);
    await fs.writeFile(path.join(skillDir, 'SKILL.md'), SKILL_MD);

    const skill = await loadSkillFromDir(skillDir);

    expect(skill.uri).toBe(pathToFileURL(path.resolve(skillDir)).href);
    expect(skill.uri).toMatch(/^file:\/\//);
  });

  it('names the directory of every skill loaded from a base path', async () => {
    const skillDir = path.join(tempDir, 'uri-skill');
    await fs.mkdir(skillDir);
    await fs.writeFile(path.join(skillDir, 'SKILL.md'), SKILL_MD);

    const skills = await loadAllSkillsInDir(tempDir);

    expect(skills['uri-skill'].uri).toBe(
      pathToFileURL(path.resolve(skillDir)).href,
    );
  });

  it('leaves a skill loaded from a zip buffer without a uri', () => {
    const zip = new AdmZip();
    zip.addFile('SKILL.md', Buffer.from(SKILL_MD));

    const skill = loadSkillFromZipBuffer(zip.toBuffer());

    expect(skill.uri).toBeUndefined();
  });
});
