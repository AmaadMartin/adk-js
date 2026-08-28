/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as path from 'node:path';
import {fileURLToPath} from 'node:url';
import {loadSkillFromDir} from '../../skills/loader.js';
import {Skill} from '../../skills/skill.js';

/**
 * Resolves the directory of the module that supplied these two locators.
 *
 * Each build output defines exactly one of them: esbuild rewrites
 * `import.meta` to an empty object in the CommonJS output, and leaves
 * `__dirname` undefined in the ECMAScript module output. The browser output
 * defines neither. `moduleUrl` wins because a host can leave a global
 * `__dirname` behind (`node -e` sets it to `.`), which would otherwise resolve
 * the skill against the working directory.
 */
export function resolveModuleDir(
  moduleUrl: string | undefined,
  dirname: string | undefined,
): string {
  if (moduleUrl !== undefined) {
    return path.dirname(fileURLToPath(moduleUrl));
  }
  if (dirname !== undefined) {
    return dirname;
  }
  throw new Error(
    'Cannot resolve the module directory: this build defines neither ' +
      'import.meta.url nor __dirname.',
  );
}

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
 * SQL. Pass the skill to a `SkillToolset` to expose it to an agent:
 *
 * ```ts
 * import {getBigQuerySkill, LlmAgent, SkillToolset} from '@google/adk';
 *
 * const agent = new LlmAgent({
 *   name: 'bq_analyst',
 *   model: 'gemini-2.5-flash',
 *   tools: [new SkillToolset([await getBigQuerySkill()])],
 * });
 * ```
 *
 * Unlike adk-python's synchronous `get_bigquery_skill`, this returns a promise,
 * because adk-js loads skills asynchronously.
 *
 * @returns The loaded BigQuery AI/ML skill.
 */
export function getBigQuerySkill(): Promise<Skill> {
  return loadSkillFromDir(bigQuerySkillDir());
}
