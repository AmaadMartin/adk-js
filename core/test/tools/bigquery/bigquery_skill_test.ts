/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  getBigQuerySkill,
  ListSkillsTool,
  LoadSkillResourceTool,
  LoadSkillTool,
  RunSkillScriptTool,
  SkillToolset,
  validateSkillDir,
} from '@google/adk';
import * as path from 'node:path';
import {pathToFileURL} from 'node:url';
import {describe, expect, it} from 'vitest';
import {SNAKE_OR_KEBAB_NAME_PATTERN} from '../../../src/skills/skill.js';
// These stay out of the public barrel, mirroring adk-python's module-private
// `_SKILL_DIR`.
import {
  bigQuerySkillDir,
  resolveModuleDir,
} from '../../../src/tools/bigquery/bigquery_skill.js';

const EXPECTED_REFERENCES = [
  'bigquery_ai_classify.md',
  'bigquery_ai_detect_anomalies.md',
  'bigquery_ai_forecast.md',
  'bigquery_ai_generate.md',
  'bigquery_ai_generate_bool.md',
  'bigquery_ai_generate_double.md',
  'bigquery_ai_generate_int.md',
  'bigquery_ai_if.md',
  'bigquery_ai_score.md',
  'bigquery_ai_search.md',
  'bigquery_ai_similarity.md',
];

describe('getBigQuerySkill', () => {
  it('returns a skill with a name, a description and instructions', async () => {
    const skill = await getBigQuerySkill();

    expect(skill.frontmatter.name).toBe('bigquery-ai-ml');
    expect(skill.frontmatter.description.length).toBeGreaterThan(0);
    expect(skill.instructions.length).toBeGreaterThan(0);
  });

  it('names the skill after its directory, in kebab-case', async () => {
    const skill = await getBigQuerySkill();

    expect(skill.frontmatter.name).toMatch(SNAKE_OR_KEBAB_NAME_PATTERN);
    expect(skill.frontmatter.name).toBe(path.basename(bigQuerySkillDir()));
  });

  it('loads every expected reference file with content', async () => {
    const skill = await getBigQuerySkill();
    const references = skill.resources?.references ?? {};

    expect(Object.keys(references).sort()).toEqual(EXPECTED_REFERENCES);
    for (const name of EXPECTED_REFERENCES) {
      expect(references[name]).toBeTypeOf('string');
      expect(references[name]!.length).toBeGreaterThan(0);
    }
  });

  it('routes the model to the reference files it ships', async () => {
    const skill = await getBigQuerySkill();

    for (const name of EXPECTED_REFERENCES) {
      expect(skill.instructions).toContain(`references/${name}`);
    }
  });

  it('exposes the four default skill tools through SkillToolset', async () => {
    const skill = await getBigQuerySkill();

    const tools = await new SkillToolset([skill]).getTools();

    expect(tools).toHaveLength(4);
    expect(tools[0]).toBeInstanceOf(ListSkillsTool);
    expect(tools[1]).toBeInstanceOf(LoadSkillTool);
    expect(tools[2]).toBeInstanceOf(LoadSkillResourceTool);
    expect(tools[3]).toBeInstanceOf(RunSkillScriptTool);
  });

  it('passes the skill directory validator', async () => {
    expect(await validateSkillDir(bigQuerySkillDir())).toEqual([]);
  });

  it('declares the license and the author and version metadata', async () => {
    const skill = await getBigQuerySkill();

    expect(skill.frontmatter.license).toBe('Apache-2.0');
    expect(skill.frontmatter.metadata).toHaveProperty('author');
    expect(skill.frontmatter.metadata).toHaveProperty('version');
  });
});

describe('resolveModuleDir', () => {
  const modulePath = path.resolve('pkg', 'esm', 'mod.js');

  it('prefers the module URL, which only the ESM output defines', () => {
    expect(
      resolveModuleDir(pathToFileURL(modulePath).href, path.resolve('cwd')),
    ).toBe(path.dirname(modulePath));
  });

  it('falls back to __dirname, which only the CommonJS output defines', () => {
    const dirname = path.resolve('pkg', 'cjs');

    expect(resolveModuleDir(undefined, dirname)).toBe(dirname);
  });

  it('refuses a build that defines neither locator', () => {
    expect(() => resolveModuleDir(undefined, undefined)).toThrow(
      /defines neither import.meta.url nor __dirname/,
    );
  });
});
