/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {readdirSync, readFileSync} from 'node:fs';
import {builtinModules} from 'node:module';
import * as path from 'node:path';
import {fileURLToPath} from 'node:url';
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

/**
 * Package names that appear in `core/src` only inside source text this package
 * *emits* for a code executor to run. They are resolved by the executor's
 * runtime in a separate module root, never by `@google/adk`, so declaring them
 * here would be a false dependency. `run_skill_script_tool.ts` emits
 * `require('ts-node/register')` into the TypeScript wrapper it builds.
 */
const GUEST_RUNTIME_PACKAGES = new Set(['ts-node']);

const SPECIFIER_PATTERN = /(?:from|import|require)\s*\(?\s*['"]([^'"]+)['"]/g;

const testDir = path.dirname(fileURLToPath(import.meta.url));
const coreRoot = path.resolve(testDir, '..');
const builtins = new Set(builtinModules);

function listTypeScriptFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir, {withFileTypes: true})) {
    const entryPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...listTypeScriptFiles(entryPath));
    } else if (entry.name.endsWith('.ts')) {
      files.push(entryPath);
    }
  }
  return files;
}

/**
 * TSDoc examples in `core/src` contain `import` statements of their own (e.g.
 * `mcp_toolset.ts` documents `import {MCPToolset} from '@google/adk';`), so
 * comments must be removed before specifiers are matched.
 */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

function toPackageName(specifier: string): string {
  const segments = specifier.split('/');
  return specifier.startsWith('@')
    ? segments.slice(0, 2).join('/')
    : segments[0];
}

function collectExternalSpecifiers(srcDir: string): ExternalSpecifier[] {
  const collected: ExternalSpecifier[] = [];
  for (const file of listTypeScriptFiles(srcDir)) {
    const source = stripComments(readFileSync(file, 'utf8'));
    for (const [, specifier] of source.matchAll(SPECIFIER_PATTERN)) {
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
        (s) =>
          !builtins.has(s.packageName) &&
          !GUEST_RUNTIME_PACKAGES.has(s.packageName) &&
          !declared.has(s.packageName),
      )
      .map((s) => `${s.file}: '${s.packageName}'`);

    expect(undeclared).toEqual([]);
    expect(collected.map((s) => s.packageName)).toContain('@google/genai');
  });
});
