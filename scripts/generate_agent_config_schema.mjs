/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Rewrites the checked-in JSON Schema for declarative agent configs.
 *
 * The schema is generated from the Zod schemas in
 * `core/src/agents/configs/agent_config.ts`, so it always describes the types
 * the loader actually validates against. Editors point `yaml-language-server`
 * at the checked-in file, which is why it is an artefact and not built at
 * runtime.
 */

import {build} from 'esbuild';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
);
const CONFIGS_DIR = path.join(REPO_ROOT, 'core', 'src', 'agents', 'configs');
const ENTRY_POINT = path.join(CONFIGS_DIR, 'agent_config_json_schema.ts');

// The bundle lands under node_modules so that Node resolves the externalised
// `zod` import from the repository's own dependency tree.
const BUNDLE_PATH = path.join(
  REPO_ROOT,
  'node_modules',
  '.cache',
  'adk-agent-config-schema',
  'agent_config_json_schema.mjs',
);

await build({
  entryPoints: [ENTRY_POINT],
  outfile: BUNDLE_PATH,
  bundle: true,
  format: 'esm',
  platform: 'node',
  packages: 'external',
  logLevel: 'error',
});

const {buildAgentConfigJsonSchema} = await import(
  pathToFileURL(BUNDLE_PATH).href
);

const outputPath = path.join(CONFIGS_DIR, 'AgentConfig.json');
await fs.writeFile(outputPath, buildAgentConfigJsonSchema(), 'utf-8');
process.stdout.write(`Wrote ${path.relative(REPO_ROOT, outputPath)}\n`);
