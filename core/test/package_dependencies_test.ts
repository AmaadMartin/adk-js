/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {readdirSync, readFileSync} from 'node:fs';
import {builtinModules} from 'node:module';
import * as path from 'node:path';
import {fileURLToPath} from 'node:url';
import ts from 'typescript';
import {describe, expect, it} from 'vitest';

/** An external module specifier found in a source file. */
interface ExternalSpecifier {
  /** The raw specifier as written, e.g. 'fs/promises' or '@a2a-js/sdk/client'. */
  specifier: string;
  /** The specifier reduced to its package name, e.g. 'fs' or '@a2a-js/sdk'. */
  packageName: string;
  /** Path of the containing file, relative to the core workspace root. */
  file: string;
}

/** The subset of package.json this test reads. */
interface PackageManifest {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
}

const testDir = path.dirname(fileURLToPath(import.meta.url));
const coreRoot = path.resolve(testDir, '..');
const builtins = new Set(builtinModules);

function toPackageName(specifier: string): string {
  const segments = specifier.split('/');
  return specifier.startsWith('@')
    ? segments.slice(0, 2).join('/')
    : segments[0];
}

/**
 * Collects the external module specifiers of every `.ts` file under `srcDir`.
 *
 * Specifiers are read with the TypeScript compiler rather than a regular
 * expression: `core/src` embeds import-like text both in TSDoc examples
 * (`mcp_toolset.ts`) and in template literals that this package emits as guest
 * source (`skill_toolset.ts`, `run_skill_script_tool.ts`), none of which are
 * imports of `@google/adk`.
 */
function collectExternalSpecifiers(srcDir: string): ExternalSpecifier[] {
  const collected: ExternalSpecifier[] = [];
  const entries = readdirSync(srcDir, {recursive: true, withFileTypes: true});

  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.ts')) {
      continue;
    }
    const file = path.join(entry.parentPath, entry.name);
    const source = readFileSync(file, 'utf8');

    for (const imported of ts.preProcessFile(source, true, true)
      .importedFiles) {
      const specifier = imported.fileName;
      if (
        specifier.startsWith('.') ||
        specifier.startsWith('/') ||
        specifier.startsWith('node:')
      ) {
        continue;
      }
      collected.push({
        specifier,
        packageName: toPackageName(specifier),
        file: path.relative(coreRoot, file),
      });
    }
  }
  return collected;
}

describe('core package dependencies', () => {
  const collected = collectExternalSpecifiers(path.join(coreRoot, 'src'));

  it('finds the imports of core/src', () => {
    expect(collected.map((s) => s.packageName)).toContain('@google/genai');
  });

  it('imports Node built-ins with the node: prefix', () => {
    const offenders = collected
      .filter((s) => builtins.has(s.packageName))
      .map((s) => `${s.file}: '${s.specifier}' -> 'node:${s.specifier}'`);

    expect(offenders).toEqual([]);
  });

  it('declares every external package imported by core/src', () => {
    const manifest = JSON.parse(
      readFileSync(path.join(coreRoot, 'package.json'), 'utf8'),
    ) as PackageManifest;
    const declared = new Set([
      ...Object.keys(manifest.dependencies ?? {}),
      ...Object.keys(manifest.devDependencies ?? {}),
      ...Object.keys(manifest.peerDependencies ?? {}),
      ...Object.keys(manifest.optionalDependencies ?? {}),
    ]);

    const undeclared = collected
      .filter(
        (s) => !builtins.has(s.packageName) && !declared.has(s.packageName),
      )
      .map((s) => `${s.file}: '${s.packageName}'`);

    expect(undeclared).toEqual([]);
  });
});
