/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import {loadAllSkillsInDir, validateSkillDir} from '@google/adk';
import {readFileSync, readdirSync} from 'node:fs';
import * as path from 'node:path';
import {describe, expect, it} from 'vitest';

const SKILLS_DIR = path.resolve(process.cwd(), '.agents/skills');

const skillDirs = readdirSync(SKILLS_DIR, {withFileTypes: true})
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name);

const readmeIndex = readFileSync(path.join(SKILLS_DIR, 'README.md'), 'utf-8');

describe('agent skills library', () => {
  it('ships the cross-language port skill', () => {
    expect(skillDirs).toContain('adk-cross-language-port');
  });

  it.each(skillDirs)('%s passes skill validation', async (name) => {
    expect(await validateSkillDir(path.join(SKILLS_DIR, name))).toEqual([]);
  });

  it('loads every skill directory', async () => {
    // loadAllSkillsInDir only warns when it skips a malformed skill, so assert
    // on the whole key set rather than a count.
    const loaded = Object.keys(await loadAllSkillsInDir(SKILLS_DIR));
    expect(loaded.sort()).toEqual([...skillDirs].sort());
  });

  it.each(skillDirs)('%s is listed in the README index', (name) => {
    expect(readmeIndex).toContain(`${name}/SKILL.md`);
  });
});
