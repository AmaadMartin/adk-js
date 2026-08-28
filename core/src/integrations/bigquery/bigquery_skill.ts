/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {parseSkillMdContent} from '../../skills/loader.js';
import {Skill} from '../../skills/skill.js';
import {
  BIGQUERY_AI_ML_REFERENCES,
  BIGQUERY_AI_ML_SKILL_MD,
} from './bigquery_ai_ml_content.js';

/**
 * Returns the pre-packaged BigQuery AI/ML skill.
 *
 * The skill follows the agentskills.io specification. Its instructions tell a
 * model to prefer BigQuery `AI.*` SQL functions over dedicated tools, and they
 * route the model to a reference file for each function before it writes any
 * SQL. Pass the skill to a `SkillToolset` to expose it to an agent.
 *
 * The instructions tell the model to run its SQL through `execute_sql()`, which
 * adk-js does not ship. Supply that tool yourself, through a BigQuery MCP
 * server or your own `FunctionTool`, or the model has no way to run the query
 * it writes.
 *
 * Every call returns a fresh object, so a caller may mutate the result.
 *
 * @experimental (Experimental, subject to change)
 * @returns The BigQuery AI/ML skill.
 */
export function getBigquerySkill(): Skill {
  const {frontmatter, body} = parseSkillMdContent(BIGQUERY_AI_ML_SKILL_MD);
  return {
    frontmatter,
    instructions: body,
    resources: {references: {...BIGQUERY_AI_ML_REFERENCES}},
  };
}
