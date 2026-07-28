/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import {validateSkillDir} from '@google/adk';
import {readFileSync, readdirSync} from 'node:fs';
import * as path from 'node:path';
import {describe, expect, it} from 'vitest';

const SKILLS_DIR = path.resolve(process.cwd(), '.agents/skills');

const skillDirs = readdirSync(SKILLS_DIR, {withFileTypes: true})
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name);

const readmeIndex = readFileSync(path.join(SKILLS_DIR, 'README.md'), 'utf-8');

describe('agent skills library', () => {
  it('is not empty', () => {
    expect(skillDirs).not.toHaveLength(0);
  });

  it.each(skillDirs)('%s passes skill validation', async (name) => {
    expect(await validateSkillDir(path.join(SKILLS_DIR, name))).toEqual([]);
  });

  it.each(skillDirs)('%s is listed in the README index', (name) => {
    expect(readmeIndex).toContain(`${name}/SKILL.md`);
  });
});
