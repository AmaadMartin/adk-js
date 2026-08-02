/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import {readFileSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {describe, expect, it} from 'vitest';

const GENAI = '@google/genai';
const OTEL_API = '@opentelemetry/api';
const WORKSPACE_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../..',
);

interface PackageManifest {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

function readManifest(workspace: string): PackageManifest {
  const manifest: PackageManifest = JSON.parse(
    readFileSync(path.join(WORKSPACE_ROOT, workspace, 'package.json'), 'utf8'),
  );
  return manifest;
}

describe(`${GENAI} in the dev workspace manifest`, () => {
  it('is declared as a runtime dependency', () => {
    // dev/src imports the runtime value createUserContent, and dev/build.js
    // builds with packages:'external', so that import survives into the
    // published dist and has to resolve from a consumer's own install.
    const dev = readManifest('dev');

    expect(dev.dependencies?.[GENAI]).toBeDefined();
    expect(dev.devDependencies?.[GENAI]).toBeUndefined();
  });

  it('declares the same range core declares', () => {
    // genai types cross the core<->dev boundary -- dev passes Content values
    // into core's public APIs -- so the two workspaces drifting onto
    // different majors is a compile break, not just untidiness. Comparing
    // against core rather than a literal makes a core-only bump fail here
    // until dev is bumped with it.
    expect(readManifest('dev').dependencies?.[GENAI]).toBe(
      readManifest('core').dependencies?.[GENAI],
    );
  });
});

describe(`${OTEL_API} in the dev workspace manifest`, () => {
  it('is declared as a runtime dependency', () => {
    // dev/src imports the runtime value trace (and calls
    // trace.getTracerProvider()), and dev/build.js builds with
    // packages:'external', so that import survives into the published dist
    // and has to resolve from a consumer's own install.
    const dev = readManifest('dev');

    expect(dev.dependencies?.[OTEL_API]).toBeDefined();
    expect(dev.devDependencies?.[OTEL_API]).toBeUndefined();
  });

  it('declares the same range core declares', () => {
    expect(readManifest('dev').dependencies?.[OTEL_API]).toBe(
      readManifest('core').dependencies?.[OTEL_API],
    );
  });

  it('is pinned exactly, because it is singleton-sensitive', () => {
    // The package registers itself on a process-global key, so a second
    // physical copy in the tree shadows the first and silently breaks
    // tracing. A range would let dev resolve a copy core cannot share.
    expect(readManifest('dev').dependencies?.[OTEL_API]).not.toMatch(/^[\^~]/);
  });
});
