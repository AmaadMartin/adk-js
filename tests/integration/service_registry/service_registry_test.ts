/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Loads a TypeScript `services.ts` under the real Node resolver.
 *
 * The unit tests run under the vitest module runner, which imports TypeScript
 * and rewrites a `./sibling.js` specifier on its own. Both are exactly what
 * the transpile step exists to provide, so only a separate `node` process can
 * show that the step works.
 */

import {spawnSync} from 'node:child_process';
import {existsSync, readdirSync} from 'node:fs';
import * as path from 'node:path';
import {fileURLToPath} from 'node:url';
import {beforeAll, describe, expect, it} from 'vitest';

const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const AGENTS_DIR = fileURLToPath(new URL('./agents', import.meta.url));

/**
 * Loads the agents directory and reports what the `demo://` scheme built.
 *
 * `services.ts` imports `@google/adk-devtools`, so it only reaches this
 * process's registry if that package stayed an import rather than being
 * bundled into the transpiled file.
 */
const SCRIPT = `
const {getServiceRegistry, loadServicesModule} = await import('@google/adk-devtools');
await loadServicesModule(process.argv[1]);
const service = await getServiceRegistry().createSessionService('demo://host', {
  agentsDir: process.argv[1],
});
process.stdout.write(JSON.stringify({
  built: service?.constructor.name,
  uri: service?.uri,
}));
`;

describe('service registry: a TypeScript services file', () => {
  beforeAll(() => {
    expect(
      existsSync(path.join(REPO_ROOT, 'dev/dist')),
      'run `npm run build` before this suite',
    ).toBe(true);
  });

  it('registers its factory in the loading process', () => {
    const result = spawnSync(
      process.execPath,
      ['--input-type=module', '-e', SCRIPT, AGENTS_DIR],
      {cwd: REPO_ROOT, encoding: 'utf-8'},
    );

    expect(result.stderr).not.toContain('Failed to load');
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      built: 'DemoSessionService',
      uri: 'demo://host#typescript',
    });
  });

  it('leaves no transpiled file in the agents directory', () => {
    spawnSync(
      process.execPath,
      ['--input-type=module', '-e', SCRIPT, AGENTS_DIR],
      {cwd: REPO_ROOT, encoding: 'utf-8'},
    );

    expect(readdirSync(AGENTS_DIR).sort()).toEqual([
      'backend.ts',
      'services.ts',
    ]);
  });
});
