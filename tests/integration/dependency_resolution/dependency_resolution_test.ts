/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {readdirSync, readFileSync} from 'node:fs';
import {builtinModules} from 'node:module';
import path from 'node:path';
import ts from 'typescript';
import {describe, expect, it} from 'vitest';

/** The subset of an npm manifest this test reads. */
interface Manifest {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
}

const REPO_ROOT = process.cwd();
const CORE_DIR = path.join(REPO_ROOT, 'core');
const BUILTIN_MODULES = new Set(builtinModules);

/**
 * Reading and parsing every `core/src` file takes ~0.5s on Linux; the margin
 * is for the slower filesystems on the Windows and macOS CI runners.
 */
const SCAN_TIMEOUT = 30000;

/** A dependency block of an npm manifest. */
type ManifestBlock = 'dependencies' | 'devDependencies';

/**
 * The audited block of every `@types/*` package in `core/package.json`.
 *
 * This is a hand-maintained ledger, not a measurement: each verdict came from
 * grepping the emitted `core/dist/types/**` for the types the package
 * provides. `@types/express` is a runtime dependency because
 * `ToA2aOptions.app` and the `toA2a` return type are `express.Application` and
 * express@4 bundles no declarations of its own, so a consumer cannot resolve
 * those types without it. `@types/node` is a runtime dependency because it is
 * the only source of the `Buffer` global, which the declarations name in
 * `loadSkillFromZipBuffer`'s parameter and in `Resources.references` and
 * `Resources.assets`; a consumer type-checking without it gets "Cannot find
 * name 'Buffer'" from inside the shipped `.d.ts`. The other two stay dev-only
 * because neither is named anywhere in the emitted declarations: `AdmZip` is
 * only ever a local inside `core/src/skills/loader.ts`, and the
 * `cloneDeep`/`isEmpty` helpers return generic or primitive types.
 *
 * Adding, removing, or re-classifying a `@types/*` package fails the test
 * below until that audit is re-run and this ledger updated to match.
 */
const AUDITED_TYPE_PACKAGE_BLOCKS: Record<string, ManifestBlock> = {
  '@types/adm-zip': 'devDependencies',
  '@types/express': 'dependencies',
  '@types/lodash-es': 'devDependencies',
  '@types/node': 'dependencies',
};

function readCoreManifest(): Manifest {
  const manifest: Manifest = JSON.parse(
    readFileSync(path.join(CORE_DIR, 'package.json'), 'utf8'),
  );
  return manifest;
}

/** Lists the manifest blocks that declare `packageName`. */
function blocksDeclaring(
  manifest: Manifest,
  packageName: string,
): ManifestBlock[] {
  const blocks: ManifestBlock[] = [];
  if (manifest.dependencies?.[packageName] !== undefined) {
    blocks.push('dependencies');
  }
  if (manifest.devDependencies?.[packageName] !== undefined) {
    blocks.push('devDependencies');
  }
  return blocks;
}

/** Returns the semver major an npm range such as `^4.17.25` resolves against. */
function majorOf(range: string): string {
  return range.replace(/^\D+/, '').split('.')[0];
}

/** Recursively collects every `.ts` file under `dir`. */
function collectTsFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir, {withFileTypes: true})) {
    const entryPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectTsFiles(entryPath));
    } else if (entry.name.endsWith('.ts')) {
      files.push(entryPath);
    }
  }
  return files;
}

/**
 * Returns the module specifier `node` imports from, or `undefined` if `node`
 * is not an import.
 *
 * Covers static `import`/`export ... from`, `import('...')` type nodes, and
 * dynamic `import()` calls.
 */
function moduleSpecifierOf(node: ts.Node): string | undefined {
  if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
    const specifier = node.moduleSpecifier;
    return specifier && ts.isStringLiteral(specifier)
      ? specifier.text
      : undefined;
  }
  if (ts.isImportTypeNode(node)) {
    return ts.isLiteralTypeNode(node.argument) &&
      ts.isStringLiteral(node.argument.literal)
      ? node.argument.literal.text
      : undefined;
  }
  if (
    ts.isCallExpression(node) &&
    node.expression.kind === ts.SyntaxKind.ImportKeyword
  ) {
    const [firstArgument] = node.arguments;
    return firstArgument && ts.isStringLiteral(firstArgument)
      ? firstArgument.text
      : undefined;
  }
  return undefined;
}

function collectSpecifiers(node: ts.Node, into: Set<string>): void {
  const specifier = moduleSpecifierOf(node);
  if (specifier !== undefined) {
    into.add(specifier);
  }
  ts.forEachChild(node, (child) => collectSpecifiers(child, into));
}

/**
 * Parses `filePath` with the TypeScript compiler and returns the module
 * specifiers it imports.
 *
 * A regex over the file text would instead report the `@google/adk` imports
 * written inside the JSDoc examples in `core/src/tools/mcp/mcp_toolset.ts` and
 * `core/src/tools/vertex_rag_retrieval_tool.ts`, which are documentation, not
 * imports.
 */
function specifiersImportedBy(filePath: string): Set<string> {
  const source = ts.createSourceFile(
    filePath,
    readFileSync(filePath, 'utf8'),
    ts.ScriptTarget.Latest,
  );
  const specifiers = new Set<string>();
  collectSpecifiers(source, specifiers);
  return specifiers;
}

/** Reduces a module specifier to the npm package it resolves from. */
function packageNameOf(specifier: string): string {
  const segments = specifier.split('/');
  return specifier.startsWith('@')
    ? segments.slice(0, 2).join('/')
    : segments[0];
}

/**
 * Returns the npm packages `dir` imports, excluding relative specifiers and
 * Node built-ins (which `core/src` imports both bare and `node:`-prefixed).
 */
function packagesImportedUnder(dir: string): Set<string> {
  const packages = new Set<string>();
  for (const file of collectTsFiles(dir)) {
    for (const specifier of specifiersImportedBy(file)) {
      if (specifier.startsWith('.') || specifier.startsWith('node:')) {
        continue;
      }
      const packageName = packageNameOf(specifier);
      if (!BUILTIN_MODULES.has(packageName)) {
        packages.add(packageName);
      }
    }
  }
  return packages;
}

describe('Dependency resolution', () => {
  it('declares openapi-types as a runtime dependency of @google/adk', () => {
    const manifest = readCoreManifest();

    expect(
      manifest.dependencies?.['openapi-types'],
      'core/package.json must declare "openapi-types" in "dependencies": ' +
        'OpenAPIV3 types are part of the public API (AuthScheme, ApiParameter, ' +
        'ParsedOperation, OpenAPIToolset, RestApiTool), so tsc emits ' +
        '`from "openapi-types"` into core/dist/types/**/*.d.ts and a consumer ' +
        'of @google/adk must have the package installed transitively.',
    ).toBeDefined();

    expect(
      manifest.devDependencies?.['openapi-types'],
      'core/package.json must not also list "openapi-types" in ' +
        '"devDependencies"; it is a runtime dependency of the published package.',
    ).toBeUndefined();
  });

  it('declares each @types/* package in its audited block', () => {
    const manifest = readCoreManifest();
    const typePackages = new Set(
      [
        ...Object.keys(manifest.dependencies ?? {}),
        ...Object.keys(manifest.devDependencies ?? {}),
      ].filter((packageName) => packageName.startsWith('@types/')),
    );

    const declared = Object.fromEntries(
      [...typePackages].map((name) => [name, blocksDeclaring(manifest, name)]),
    );
    const audited = Object.fromEntries(
      Object.entries(AUDITED_TYPE_PACKAGE_BLOCKS).map(([name, block]) => [
        name,
        [block],
      ]),
    );

    expect(
      declared,
      "core/package.json's @types/* packages must match the audited ledger " +
        'in AUDITED_TYPE_PACKAGE_BLOCKS. A type package whose types are ' +
        'reachable from core/dist/types/**/*.d.ts belongs in "dependencies", ' +
        'because consumers of @google/adk never install devDependencies; one ' +
        'whose types stay internal belongs in "devDependencies" so consumers ' +
        'do not carry it. Re-run that audit and update the ledger in the same ' +
        'commit that changes the manifest.',
    ).toEqual(audited);
  });

  it('keeps express and @types/express on the same semver major', () => {
    const manifest = readCoreManifest();
    const expressRange = manifest.dependencies?.['express'];
    const typesRange = manifest.dependencies?.['@types/express'];

    if (expressRange === undefined || typesRange === undefined) {
      expect.fail(
        'core/package.json must declare both "express" and "@types/express" ' +
          'in "dependencies".',
      );
    }

    expect(
      majorOf(typesRange),
      `"@types/express": "${typesRange}" describes express ` +
        `${majorOf(typesRange)}.x, but "express": "${expressRange}" resolves ` +
        `express ${majorOf(expressRange)}.x. The two must be upgraded ` +
        `together, or the shipped declarations describe an express a ` +
        `consumer does not have.`,
    ).toBe(majorOf(expressRange));
  });

  it(
    'declares every package imported by core/src as a runtime or peer dependency',
    () => {
      const manifest = readCoreManifest();
      const declared = new Set([
        ...Object.keys(manifest.dependencies ?? {}),
        ...Object.keys(manifest.peerDependencies ?? {}),
      ]);

      const undeclared = [...packagesImportedUnder(path.join(CORE_DIR, 'src'))]
        .filter((packageName) => !declared.has(packageName))
        .sort();

      expect(
        undeclared,
        `core/src imports these packages, but core/package.json does not ` +
          `declare them in "dependencies" or "peerDependencies": ` +
          `${undeclared.join(', ')}. Anything core/src imports can survive ` +
          `into core/dist/types/**/*.d.ts, so a consumer of @google/adk must ` +
          `be able to resolve it.`,
      ).toEqual([]);
    },
    SCAN_TIMEOUT,
  );
});
