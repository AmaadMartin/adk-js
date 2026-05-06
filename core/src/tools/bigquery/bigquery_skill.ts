/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as path from 'node:path';
import {fileURLToPath} from 'node:url';
import {loadSkillFromDir} from '../../skills/loader.js';
import {Skill} from '../../skills/skill.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const SKILL_DIR = path.join(__dirname, 'skills', 'bigquery-ai-ml');

/**
 * Returns the pre-packaged BigQuery data analysis skill.
 */
export async function getBigQuerySkill(): Promise<Skill> {
  return loadSkillFromDir(SKILL_DIR);
}
