/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import {readFile} from 'node:fs/promises';
import * as path from 'node:path';
import {describe, expect, it} from 'vitest';

/**
 * esbuild prepends a `createRequire` shim to every file of the `esm` and `web`
 * targets so that `require` exists in ESM output. The banner is emitted
 * verbatim into published artifacts, so its specifier must use the `node:`
 * scheme: a bare `module` specifier can be shadowed by an npm package of the
 * same name in a consumer's resolution chain.
 */
const BANNER_IMPORT =
  /^import \{createRequire as topLevelCreateRequire\} from '([^']*)';/;

const BANNERED_ARTIFACTS = [
  'core/dist/esm/index.js',
  'core/dist/web/index_web.js',
  'integrations/dist/esm/index.js',
  'integrations/dist/web/index_web.js',
];

const UNBANNERED_ARTIFACTS = [
  'core/dist/cjs/index.js',
  'integrations/dist/cjs/index.js',
];

function readArtifact(artifact: string): Promise<string> {
  return readFile(path.join(process.cwd(), artifact), 'utf8');
}

describe('generated ESM build banner', () => {
  it.each(BANNERED_ARTIFACTS)('imports node:module in %s', async (artifact) => {
    const [firstLine] = (await readArtifact(artifact)).split('\n');

    const banner = BANNER_IMPORT.exec(firstLine);
    if (!banner) {
      expect.fail(`no createRequire banner in ${artifact}, got: ${firstLine}`);
    }
    expect(banner[1]).toBe('node:module');
  });

  it.each(UNBANNERED_ARTIFACTS)('emits no banner in %s', async (artifact) => {
    expect(await readArtifact(artifact)).not.toContain('topLevelCreateRequire');
  });
});
