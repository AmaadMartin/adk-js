/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as adk from '@google/adk';
import esbuild from 'esbuild';
import {isBuiltin} from 'node:module';
import {fileURLToPath} from 'node:url';
import {describe, expect, it} from 'vitest';
import * as web from '../src/index_web.js';

/**
 * The Node built-ins the browser build is allowed to reach, because
 * `buildOptions.alias` in `core/build.js` swaps each one for a browser
 * implementation. Keep this set in step with that alias table.
 *
 * The `import {createRequire} from 'module'` banner is excluded on purpose: it
 * is injected after the module graph is resolved, so it never appears in the
 * metafile, and removing it from the browser build is separately queued work.
 */
const ALIASED_NODE_BUILTINS = new Set(['node:async_hooks']);

/** Symbols that are Node-only and must not reach the browser entry point. */
const NODE_ONLY_EXPORTS = [
  'LOAD_WEB_PAGE',
  'loadWebPage',
  'GCPSkillRegistry',
  'loadAllSkillsInDir',
  'loadSkillFromDir',
  'loadSkillFromZipBuffer',
  'validateSkillDir',
  'ListSkillsTool',
  'LoadSkillResourceTool',
  'LoadSkillTool',
  'SearchSkillsTool',
  'SkillToolset',
] as const;

const coreDir = fileURLToPath(new URL('..', import.meta.url));

/** Budget (ms) for the bundle below: it walks the whole browser export graph. */
const BUNDLE_TIMEOUT_MS = 30000;

describe('browser entry point', () => {
  it(
    'reaches no Node built-in the browser build does not alias',
    async () => {
      const result = await esbuild.build({
        absWorkingDir: coreDir,
        entryPoints: ['./src/index_web.ts'],
        platform: 'browser',
        format: 'esm',
        target: ['chrome58', 'firefox57', 'safari11'],
        bundle: true,
        packages: 'external',
        logLevel: 'silent',
        metafile: true,
        write: false,
      });

      const [output] = Object.values(result.metafile.outputs);
      const imported = new Set(
        output.imports.map((entry) => entry.path).filter(isBuiltin),
      );

      expect(imported).toEqual(ALIASED_NODE_BUILTINS);
    },
    BUNDLE_TIMEOUT_MS,
  );

  it('does not export the Node-only skills and web-page symbols', () => {
    for (const name of NODE_ONLY_EXPORTS) {
      expect(
        web,
        `${name} leaked into the browser entry point`,
      ).not.toHaveProperty(name);
    }
  });

  it('still exports the platform-neutral symbols', () => {
    expect(web).toHaveProperty('LlmAgent');
    expect(web).toHaveProperty('InMemorySessionService');
  });
});

describe('Node entry point', () => {
  it('still exports the Node-only skills and web-page symbols', () => {
    for (const name of NODE_ONLY_EXPORTS) {
      expect(
        adk,
        `${name} disappeared from the Node entry point`,
      ).toHaveProperty(name);
    }
  });
});
