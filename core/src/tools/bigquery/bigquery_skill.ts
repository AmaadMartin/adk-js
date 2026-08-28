/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as path from 'node:path';
import {loadSkillFromDir} from '../../skills/loader.js';
import {Skill} from '../../skills/skill.js';
import {resolveModuleDir} from '../../utils/module_dir_utils.js';

/**
 * Returns the directory holding the packaged BigQuery AI/ML skill.
 *
 * This resolves per call rather than at module load, so importing the barrel
 * in a browser build stays inert and only a call fails.
 */
export function bigQuerySkillDir(): string {
  const dirname = typeof __dirname !== 'undefined' ? __dirname : undefined;
  return path.join(
    resolveModuleDir(import.meta.url, dirname),
    'skills',
    'bigquery-ai-ml',
  );
}

/**
 * Loads the pre-packaged BigQuery AI/ML skill.
 *
 * The skill follows the agentskills.io specification. Its instructions tell a
 * model to prefer BigQuery `AI.*` SQL functions over dedicated tools, and they
 * route the model to a reference file for each function before it writes any
 * SQL. Pass the skill to a `SkillToolset` to expose it to an agent.
 *
 * Unlike adk-python's synchronous `get_bigquery_skill`, this returns a promise,
 * because adk-js loads skills asynchronously. It reads the skill from the
 * filesystem, so it works under Node and fails in a browser.
 *
 * @returns The loaded BigQuery AI/ML skill.
 */
export function getBigQuerySkill(): Promise<Skill> {
  return loadSkillFromDir(bigQuerySkillDir());
}
