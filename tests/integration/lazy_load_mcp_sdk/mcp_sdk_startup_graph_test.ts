/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as esbuild from 'esbuild';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {beforeAll, describe, expect, it} from 'vitest';

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../..',
);

/** The core barrel, the entry point every `import '@google/adk'` evaluates. */
const BARREL = 'core/src/index.ts';

/** The MCP SDK is imported by subpath, so the guard matches on this prefix. */
const MCP_SDK_PACKAGE = '@modelcontextprotocol/sdk';

/** A package the barrel reaches with a plain `import` statement. */
interface StaticExternal {
  specifier: string;
  /** Modules from the barrel to the importer, for the failure message. */
  chain: string[];
}

/**
 * Lists the packages the barrel loads at import time.
 *
 * `core/build.js` publishes the package with this same bundler and options, so
 * the traced graph is the graph the published build produces. Only
 * `import-statement` edges are followed: a `dynamic-import` edge is deferred
 * work, which is exactly what this guard protects.
 *
 * A statement esbuild erased still appears in the metafile unless it is
 * written `import type`, so a type-only import of a package counts as static
 * here.
 */
async function traceStaticExternals(): Promise<StaticExternal[]> {
  const result = await esbuild.build({
    absWorkingDir: REPO_ROOT,
    entryPoints: [BARREL],
    bundle: true,
    packages: 'external',
    write: false,
    metafile: true,
    platform: 'node',
    format: 'esm',
    logLevel: 'silent',
  });

  const inputs = result.metafile.inputs;
  const externals: StaticExternal[] = [];
  const visited = new Set<string>([BARREL]);
  const queue: StaticExternal[] = [{specifier: BARREL, chain: [BARREL]}];

  for (let i = 0; i < queue.length; i++) {
    const {specifier: module, chain} = queue[i];
    for (const imported of inputs[module]?.imports ?? []) {
      if (imported.kind !== 'import-statement') {
        continue;
      }
      if (imported.external) {
        // esbuild reports an erased relative import as external too; those are
        // repo files, not packages.
        if (!imported.path.startsWith('.')) {
          externals.push({specifier: imported.path, chain});
        }
        continue;
      }
      if (visited.has(imported.path)) {
        continue;
      }
      visited.add(imported.path);
      queue.push({specifier: imported.path, chain: [...chain, imported.path]});
    }
  }

  return externals;
}

function describeEdge({specifier, chain}: StaticExternal): string {
  return [...chain, specifier].join(' -> ');
}

describe('core barrel static import graph', () => {
  let externals: StaticExternal[];

  beforeAll(async () => {
    externals = await traceStaticExternals();
  });

  it('reaches @google/genai statically', () => {
    // Positive control: an empty or broken trace cannot pass the guard below.
    expect(externals.map((edge) => edge.specifier)).toContain('@google/genai');
  });

  it('does not reach the MCP SDK statically', () => {
    const mcpEdges = externals
      .filter((edge) => edge.specifier.startsWith(MCP_SDK_PACKAGE))
      .map(describeEdge);

    expect(mcpEdges).toEqual([]);
  });
});
