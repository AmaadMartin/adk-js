/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  Context,
  createSession,
  getBigquerySkill,
  InvocationContext,
  loadSkillFromDir,
  LoadSkillResourceTool,
  PluginManager,
  SkillToolset,
  validateSkillDir,
} from '@google/adk';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {afterEach, describe, expect, it} from 'vitest';
import {
  BIGQUERY_AI_ML_REFERENCES,
  BIGQUERY_AI_ML_SKILL_MD,
} from '../../src/integrations/bigquery/bigquery_ai_ml_content.js';

const SKILL_NAME = 'bigquery-ai-ml';

/** adk-python's stricter kebab-case rule for a skill name. */
const KEBAB_NAME_PATTERN = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;

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

/** Writes the embedded skill to disk as a real skill directory. */
async function writeSkillDir(root: string): Promise<string> {
  const skillDir = path.join(root, SKILL_NAME);
  await fs.mkdir(path.join(skillDir, 'references'), {recursive: true});
  await fs.writeFile(
    path.join(skillDir, 'SKILL.md'),
    BIGQUERY_AI_ML_SKILL_MD,
    'utf-8',
  );
  for (const [name, content] of Object.entries(BIGQUERY_AI_ML_REFERENCES)) {
    await fs.writeFile(
      path.join(skillDir, 'references', name),
      content,
      'utf-8',
    );
  }
  return skillDir;
}

describe('getBigquerySkill', () => {
  let tempRoot: string | undefined;

  afterEach(async () => {
    if (tempRoot !== undefined) {
      await fs.rm(tempRoot, {recursive: true, force: true});
      tempRoot = undefined;
    }
  });

  it('returns a skill with a name, a description and instructions', () => {
    const skill = getBigquerySkill();

    expect(skill.frontmatter.name).toBe(SKILL_NAME);
    expect(skill.frontmatter.description.length).toBeGreaterThan(0);
    expect(skill.instructions.length).toBeGreaterThan(0);
  });

  it('names the skill in kebab-case, as adk-python does', () => {
    expect(getBigquerySkill().frontmatter.name).toMatch(KEBAB_NAME_PATTERN);
  });

  it('carries every expected reference as non-empty text', () => {
    const references = getBigquerySkill().resources?.references ?? {};

    expect(Object.keys(references).sort()).toEqual(EXPECTED_REFERENCES);
    for (const name of EXPECTED_REFERENCES) {
      expect(references[name]).toBeTypeOf('string');
      expect(references[name].length).toBeGreaterThan(0);
    }
  });

  it('exposes the four default skill tools through SkillToolset', async () => {
    const tools = await new SkillToolset([getBigquerySkill()]).getTools();

    expect(tools.map((tool) => tool.name)).toEqual([
      'list_skills',
      'load_skill',
      'load_skill_resource',
      'run_skill_script',
    ]);
  });

  it('serves a reference through load_skill_resource', async () => {
    const toolset = new SkillToolset([getBigquerySkill()]);
    const toolContext = new Context({
      invocationContext: new InvocationContext({
        invocationId: 'bq-invocation',
        session: createSession({id: 'bq-session', appName: 'bq-app'}),
        pluginManager: new PluginManager(),
      }),
    });

    const result = await new LoadSkillResourceTool(toolset).runAsync({
      args: {skill_name: SKILL_NAME, path: 'references/bigquery_ai_if.md'},
      toolContext,
    });

    expect(result).toMatchObject({
      skill_name: SKILL_NAME,
      path: 'references/bigquery_ai_if.md',
      content: expect.stringContaining('AI.IF'),
    });
  });

  it('matches a skill loaded from a real directory', async () => {
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'adk-bq-skill-'));
    const skillDir = await writeSkillDir(tempRoot);
    const embedded = getBigquerySkill();

    const problems = await validateSkillDir(skillDir);
    const loaded = await loadSkillFromDir(skillDir);

    expect(problems).toEqual([]);
    expect(loaded.frontmatter).toEqual(embedded.frontmatter);
    expect(loaded.instructions).toEqual(embedded.instructions);
    expect(loaded.resources?.references).toEqual(
      embedded.resources?.references,
    );
  });

  it('declares the Apache-2.0 license', () => {
    expect(getBigquerySkill().frontmatter.license).toBe('Apache-2.0');
  });

  it('declares the author and the version metadata', () => {
    const metadata = getBigquerySkill().frontmatter.metadata;

    expect(metadata).toHaveProperty('author', 'google-adk');
    expect(metadata).toHaveProperty('version', '1.0');
  });

  it('keeps the code fences and the inline code of a reference intact', () => {
    const forecast =
      getBigquerySkill().resources?.references?.['bigquery_ai_forecast.md'];

    expect(forecast).toContain('`AI.FORECAST`');
    expect(forecast).toContain('```sql');
  });

  it('routes the model only to reference files it ships', () => {
    const skill = getBigquerySkill();
    const shipped = Object.keys(skill.resources?.references ?? {});
    const routed = [
      ...skill.instructions.matchAll(/`references\/([\w.]+)`/g),
    ].map((match) => match[1]);

    expect(skill.instructions.startsWith('---')).toBe(false);
    expect(skill.instructions).toContain(`# Skill: ${SKILL_NAME}`);
    expect(routed.sort()).toEqual(EXPECTED_REFERENCES);
    for (const name of routed) {
      expect(shipped).toContain(name);
    }
  });

  it('gives every caller its own references record', () => {
    const first = getBigquerySkill();

    delete first.resources?.references?.['bigquery_ai_forecast.md'];

    expect(getBigquerySkill().resources?.references).toHaveProperty(
      'bigquery_ai_forecast.md',
    );
  });
});
