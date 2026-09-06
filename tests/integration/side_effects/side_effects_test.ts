/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import esbuild from 'esbuild';
import {existsSync, readdirSync, readFileSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import ts from 'typescript';
import {beforeAll, describe, expect, it} from 'vitest';

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../..',
);

const WORKSPACES = ['integrations', 'dev'] as const;

/**
 * Top-level statement kinds that only bind names. A bundler that drops a module
 * built solely from these loses nothing observable, so they need no
 * `sideEffects` entry. `VariableStatement` belongs here even though an
 * initialiser can call a function: the call produces the binding's value, which
 * dies with the module. Every other kind runs at import time.
 */
const DECLARATION_KINDS: ReadonlySet<ts.SyntaxKind> = new Set([
  ts.SyntaxKind.ImportDeclaration,
  ts.SyntaxKind.ImportEqualsDeclaration,
  ts.SyntaxKind.ExportDeclaration,
  ts.SyntaxKind.ExportAssignment,
  ts.SyntaxKind.FunctionDeclaration,
  ts.SyntaxKind.ClassDeclaration,
  ts.SyntaxKind.InterfaceDeclaration,
  ts.SyntaxKind.TypeAliasDeclaration,
  ts.SyntaxKind.EnumDeclaration,
  ts.SyntaxKind.ModuleDeclaration,
  ts.SyntaxKind.VariableStatement,
  ts.SyntaxKind.EmptyStatement,
]);

function toPosix(filePath: string): string {
  return filePath.split(path.sep).join('/');
}

function sourceDir(workspace: string): string {
  return path.join(REPO_ROOT, workspace, 'src');
}

function barrelPath(workspace: string): string {
  return path.join(REPO_ROOT, workspace, 'dist', 'esm', 'index.js');
}

function listTypeScriptFiles(dir: string): string[] {
  return readdirSync(dir, {withFileTypes: true}).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return listTypeScriptFiles(full);
    return entry.isFile() && full.endsWith('.ts') ? [full] : [];
  });
}

function hasImportTimeSideEffect(file: string): boolean {
  const source = ts.createSourceFile(
    file,
    readFileSync(file, 'utf8'),
    ts.ScriptTarget.ESNext,
    true,
  );
  return source.statements.some(
    (statement) => !DECLARATION_KINDS.has(statement.kind),
  );
}

/**
 * Returns the `srcDir`-relative POSIX paths of the modules that run code when
 * they are imported.
 */
function collectSideEffectModules(srcDir: string): string[] {
  return listTypeScriptFiles(srcDir)
    .filter(hasImportTimeSideEffect)
    .map((file) => toPosix(path.relative(srcDir, file)));
}

function isStringArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) && value.every((entry) => typeof entry === 'string')
  );
}

function readSideEffectsField(workspace: string): unknown {
  const manifest: unknown = JSON.parse(
    readFileSync(path.join(REPO_ROOT, workspace, 'package.json'), 'utf8'),
  );
  if (
    typeof manifest !== 'object' ||
    manifest === null ||
    !('sideEffects' in manifest)
  ) {
    return undefined;
  }
  return manifest.sideEffects;
}

/**
 * Reduces the manifest field to the sorted module list it declares. `false`
 * declares none. Any other shape is returned unchanged so that a missing or
 * malformed field shows up verbatim in the failure diff.
 */
function declaredModules(field: unknown): unknown {
  if (field === false) return [];
  return isStringArray(field) ? [...field].sort() : field;
}

/** Maps a `src`-relative TypeScript path onto the JavaScript path it builds to. */
function builtModule(module: string): string {
  return module.replace(/\.ts$/, '.js');
}

/** Maps a `src`-relative module path onto its published manifest entry. */
function manifestEntry(module: string): string {
  return `./dist/*/${builtModule(module)}`;
}

/**
 * Bundles `import '<entry>';` and returns the built package modules esbuild
 * kept. A module absent from this list was tree-shaken away, and any code it
 * runs at import time is gone with it.
 */
async function retainedModules(entry: string): Promise<string[]> {
  const result = await esbuild.build({
    stdin: {
      contents: `import ${JSON.stringify(entry)};`,
      resolveDir: REPO_ROOT,
      sourcefile: 'side_effects_probe.js',
      loader: 'js',
    },
    bundle: true,
    write: false,
    format: 'esm',
    platform: 'node',
    // Keeps express, @mikro-orm/* and @google/adk out of the graph, so a
    // failing assertion fails fast instead of bundling the world.
    packages: 'external',
    metafile: true,
    // Suppresses the [ignored-bare-import] warning, which is the success path.
    logLevel: 'silent',
  });
  return Object.values(result.metafile.outputs)
    .flatMap((output) => Object.keys(output.inputs))
    .map(toPosix)
    .filter((input) => input.includes('/dist/'));
}

/** Built ESM paths of every audited module, e.g. `dev/dist/esm/cli/cli.js`. */
const AUDITED_MODULES = WORKSPACES.flatMap((workspace) =>
  collectSideEffectModules(sourceDir(workspace)).map(
    (module) => `${workspace}/dist/esm/${builtModule(module)}`,
  ),
);

describe('package sideEffects manifests', () => {
  it.each(WORKSPACES)(
    '%s declares exactly the modules that have import-time side effects',
    (workspace) => {
      const expected = collectSideEffectModules(sourceDir(workspace))
        .map(manifestEntry)
        .sort();

      expect(declaredModules(readSideEffectsField(workspace))).toEqual(
        expected,
      );
    },
  );

  it('integrations declares that it has no side effects at all', () => {
    expect(readSideEffectsField('integrations')).toBe(false);
  });
});

describe('published package tree shaking', () => {
  beforeAll(() => {
    for (const workspace of WORKSPACES) {
      const barrel = barrelPath(workspace);
      expect(
        existsSync(barrel),
        `${barrel} is missing. Run "npm run build" first: this suite measures the published package shape, not src.`,
      ).toBe(true);
    }
  });

  it.each(WORKSPACES)(
    'a bundler drops the %s barrel when nothing is imported from it',
    async (workspace) => {
      expect(await retainedModules(barrelPath(workspace))).toEqual([]);
    },
  );

  it.each(AUDITED_MODULES)(
    'a bundler keeps %s because the manifest declares it',
    async (built) => {
      expect(await retainedModules(path.join(REPO_ROOT, built))).toContain(
        built,
      );
    },
  );
});
