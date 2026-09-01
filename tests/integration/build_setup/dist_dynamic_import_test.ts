/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Guards the one thing the unit suite cannot see: what `import()` becomes in
 * the published build.
 *
 * `core/build.js` targets a Node version that predates `import()`, so esbuild
 * will compile it down to `require()` unless the build says otherwise.
 * `require()` rejects the `file://` URL that loading a module by path needs,
 * and cannot read an ES module on Node below 20.19. Every unit test runs the
 * TypeScript source, where `import()` is untouched, so only a child process
 * running the built artifact can catch a regression here.
 */

import {spawnSync} from 'node:child_process';
import path from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {describe, expect, it} from 'vitest';

const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));

const AGENT_MODULE = path.join(
  REPO_ROOT,
  'tests/integration/build_setup/fixtures/agent_module.mjs',
);

/** The agent name the fixture exports. */
const AGENT_NAME = 'built_dist_agent';

const ESM_SCRIPT = `
const {getAgentForEval} = await import(process.env.ADK_LOADER);
const {agent} = await getAgentForEval(process.env.ADK_AGENT_MODULE);
process.stdout.write(agent.name);
`;

const CJS_SCRIPT = `
const {getAgentForEval} = require(process.env.ADK_LOADER);
getAgentForEval(process.env.ADK_AGENT_MODULE).then(({agent}) => {
  process.stdout.write(agent.name);
});
`;

/** A build of the package, and how a consumer of it reaches a module. */
interface BuiltPackage {
  /** The directory under `core/dist`. */
  dist: string;
  /** Node's `--input-type`, which decides how the script loads the module. */
  inputType: 'module' | 'commonjs';
  script: string;
  /** Whether the loader is reached by URL, as ESM requires. */
  byUrl: boolean;
}

const BUILDS: BuiltPackage[] = [
  {dist: 'esm', inputType: 'module', script: ESM_SCRIPT, byUrl: true},
  {dist: 'cjs', inputType: 'commonjs', script: CJS_SCRIPT, byUrl: false},
];

describe.each(BUILDS)(
  'the $dist build of @google/adk',
  ({dist, inputType, script, byUrl}) => {
    it('loads an ES module agent named by a filesystem path', () => {
      const loader = path.join(
        REPO_ROOT,
        'core/dist',
        dist,
        'evaluation/agent_module_loader.js',
      );

      const result = spawnSync(
        process.execPath,
        [`--input-type=${inputType}`, '-e', script],
        {
          cwd: REPO_ROOT,
          encoding: 'utf8',
          env: {
            ...process.env,
            ADK_LOADER: byUrl ? pathToFileURL(loader).href : loader,
            ADK_AGENT_MODULE: AGENT_MODULE,
          },
        },
      );

      expect(result.stderr).not.toContain('Cannot find module');
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toBe(AGENT_NAME);
    });
  },
);
