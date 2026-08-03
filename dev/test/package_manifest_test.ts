/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {describe, expect, it} from 'vitest';

interface Manifest {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

function readManifest(relativePath: string): Manifest {
  return JSON.parse(
    readFileSync(fileURLToPath(new URL(relativePath, import.meta.url)), 'utf8'),
  ) as Manifest;
}

const coreManifest = readManifest('../../core/package.json');
const devManifest = readManifest('../package.json');

/**
 * Packages dev/src imports at runtime that core also depends on. Both
 * workspaces must request the identical range so npm resolves a single copy:
 * two copies of @opentelemetry/api in one process each carry their own global
 * tracer registry, and spans recorded against one are invisible to the other.
 */
const SHARED_RUNTIME_DEPENDENCIES = [
  '@google-cloud/vertexai',
  '@google/genai',
  '@opentelemetry/api',
  '@opentelemetry/sdk-trace-base',
  'lodash-es',
];

describe('dev package manifest', () => {
  it.each(SHARED_RUNTIME_DEPENDENCIES)(
    'declares %s as a runtime dependency matching core',
    (name) => {
      expect(coreManifest.dependencies?.[name]).toBeDefined();
      expect(devManifest.dependencies?.[name]).toBe(
        coreManifest.dependencies?.[name],
      );
    },
  );

  it('declares @types/lodash-es so lodash-es typechecks in a standalone build', () => {
    expect(coreManifest.devDependencies?.['@types/lodash-es']).toBeDefined();
    expect(devManifest.devDependencies?.['@types/lodash-es']).toBe(
      coreManifest.devDependencies?.['@types/lodash-es'],
    );
  });
});
