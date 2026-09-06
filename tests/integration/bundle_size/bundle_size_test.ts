/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import esbuild from 'esbuild';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import {beforeAll, describe, expect, it, vi} from 'vitest';
import {AgentFile} from '../../../dev/src/utils/agent_loader.js';

const REPO_ROOT = process.cwd();
const FIXTURE_DIR = path.join(REPO_ROOT, 'tests/integration/bundle_size');
const MINIMAL_AGENT_FIXTURE = path.join(FIXTURE_DIR, 'minimal_agent.ts');
const REGISTRY_AGENT_FIXTURE = path.join(FIXTURE_DIR, 'registry_agent.ts');
const CORE_ESM_ENTRY = path.join(REPO_ROOT, 'core/dist/esm/index.js');

/**
 * Byte budget for a minimal agent bundled through the real `AgentFile.load()`
 * code path, which is what `adk web` and `adk run` pay on every cold start.
 *
 * Measured at 1,403,802 bytes when this guard landed, down from 5,879,678
 * bytes before `@google/adk` declared `"sideEffects": false`. The ~20%
 * headroom is deliberate slack for dependency drift. Raising this number is an
 * explicit decision about what a minimal agent may cost, not a way to make a
 * red build green.
 */
const MAX_MINIMAL_AGENT_BUNDLE_BYTES = 1_750_000;

/**
 * Optional subsystems a minimal agent must never reach. Each entry is a
 * `node_modules` path prefix as esbuild reports it in the metafile inputs.
 */
const HEAVY_PACKAGE_PATTERNS = [
  'node_modules/@mikro-orm/',
  'node_modules/express/',
  'node_modules/@a2a-js/',
  'node_modules/@modelcontextprotocol/',
  'node_modules/@google-cloud/storage/',
  'node_modules/@opentelemetry/sdk-',
  'node_modules/protobufjs/',
  'node_modules/googleapis/',
  'node_modules/@grpc/',
  'node_modules/iconv-lite/',
];

/** Caps the example paths in a failure message; a regression matches hundreds. */
const MAX_REPORTED_EXAMPLES = 5;

/** Returns every module esbuild reaches when it bundles `entryPoint`. */
async function bundleInputPaths(entryPoint: string): Promise<string[]> {
  const result = await esbuild.build({
    entryPoints: [entryPoint],
    platform: 'node',
    format: 'esm',
    packages: 'bundle',
    bundle: true,
    minify: true,
    metafile: true,
    write: false,
  });

  return Object.values(result.metafile.outputs).flatMap((output) =>
    Object.keys(output.inputs),
  );
}

describe('Minimal agent bundle size', () => {
  beforeAll(async () => {
    try {
      await fs.stat(CORE_ESM_ENTRY);
    } catch {
      throw new Error(
        `${CORE_ESM_ENTRY} is missing. Run "npm run build" first: this suite ` +
          `measures the published package shape, not core/src.`,
      );
    }
  });

  it('keeps a minimal agent bundle under the size budget', async () => {
    const agentFile = new AgentFile(MINIMAL_AGENT_FIXTURE);

    try {
      await agentFile.load();
      const {size} = await fs.stat(agentFile.getFilePath());

      expect(
        size,
        `minimal agent bundles to ${size} bytes, budget is ${MAX_MINIMAL_AGENT_BUNDLE_BYTES}`,
      ).toBeLessThan(MAX_MINIMAL_AGENT_BUNDLE_BYTES);
    } finally {
      await agentFile.dispose();
    }
  });

  it('does not bundle the heavy optional subsystems', async () => {
    const inputs = await bundleInputPaths(MINIMAL_AGENT_FIXTURE);

    const reachedPatterns = HEAVY_PACKAGE_PATTERNS.filter((pattern) =>
      inputs.some((input) => input.includes(pattern)),
    );
    const examples = inputs
      .filter((input) => reachedPatterns.some((p) => input.includes(p)))
      .slice(0, MAX_REPORTED_EXAMPLES);

    expect(
      reachedPatterns,
      `minimal agent reaches subsystems it must not, for example: ${examples.join(', ')}`,
    ).toEqual([]);
  });

  it('still registers the built-in models after tree-shaking', async () => {
    // The fixture resolves `gemini-2.5-flash` through `LLMRegistry` at module
    // scope, so `load()` rejects if tree-shaking drops the built-in
    // registrations. `new Gemini(...)` needs an API key to construct.
    vi.stubEnv('GOOGLE_GENAI_API_KEY', 'test-api-key');
    const agentFile = new AgentFile(REGISTRY_AGENT_FIXTURE);

    try {
      const app = await agentFile.loadApp();

      expect(app.name).toBe('registry_app');
      expect(app.rootAgent.name).toBe('registry_agent');
    } finally {
      await agentFile.dispose();
      vi.unstubAllEnvs();
    }
  });
});
