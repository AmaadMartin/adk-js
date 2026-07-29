/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import ts from 'typescript';
import {describe, expect, it} from 'vitest';

const SRC_DIR = path.resolve(__dirname, '../../src');
const GOLDEN_PATH = path.resolve(__dirname, 'public_exports.golden.json');

/** Entry points whose star re-exports must each name a distinct module. */
const ENTRY_POINTS = ['common.ts', 'index.ts', 'index_web.ts'];

const REFRESH_INSTRUCTIONS =
  'Public export surface of @google/adk changed. If this is intended, ' +
  'refresh the golden with: UPDATE_GOLDEN=1 npx vitest run ' +
  '--project unit:core core/test/public_api/public_api_test.ts';

/** What a single source file contributes to the export graph. */
export interface FileExports {
  /**
   * Module specifiers of `export * from '...'` in source order. Duplicates are
   * preserved — the duplicate guard depends on that.
   */
  starSpecifiers: string[];
  /** Names this file introduces directly (named re-exports + declarations). */
  ownNames: string[];
}

function unsupportedExport(fileName: string, construct: string): Error {
  return new Error(`Unsupported export syntax in ${fileName}: ${construct}`);
}

function isExported(node: ts.Node): boolean {
  return (
    ts.canHaveModifiers(node) &&
    !!ts
      .getModifiers(node)
      ?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)
  );
}

/**
 * Parse-only scan of one TypeScript source. Throws on any export form it does
 * not understand, so an unhandled form can never be silently dropped from the
 * golden.
 */
export function scanSource(fileName: string, text: string): FileExports {
  const source = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest);
  const starSpecifiers: string[] = [];
  const ownNames: string[] = [];

  for (const statement of source.statements) {
    if (ts.isExportDeclaration(statement)) {
      const {exportClause, moduleSpecifier} = statement;
      if (!exportClause) {
        if (!moduleSpecifier || !ts.isStringLiteral(moduleSpecifier)) {
          throw unsupportedExport(fileName, 'star export of a non-literal');
        }
        starSpecifiers.push(moduleSpecifier.text);
      } else if (ts.isNamedExports(exportClause)) {
        for (const element of exportClause.elements) {
          ownNames.push(element.name.text);
        }
      } else {
        throw unsupportedExport(fileName, 'export * as');
      }
      continue;
    }

    // An export assignment carries no `export` modifier, so it has to be
    // rejected before the modifier check below skips over it.
    if (ts.isExportAssignment(statement)) {
      throw unsupportedExport(fileName, 'export default or export =');
    }

    if (!isExported(statement)) {
      continue;
    }

    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (!ts.isIdentifier(declaration.name)) {
          throw unsupportedExport(fileName, 'destructured export');
        }
        ownNames.push(declaration.name.text);
      }
      continue;
    }

    if (
      ts.isFunctionDeclaration(statement) ||
      ts.isClassDeclaration(statement) ||
      ts.isInterfaceDeclaration(statement) ||
      ts.isTypeAliasDeclaration(statement) ||
      ts.isEnumDeclaration(statement)
    ) {
      if (!statement.name) {
        throw unsupportedExport(fileName, 'unnamed export');
      }
      ownNames.push(statement.name.text);
      continue;
    }

    throw unsupportedExport(fileName, ts.SyntaxKind[statement.kind]);
  }

  return {starSpecifiers, ownNames};
}

function resolveStarSpecifier(fromFile: string, specifier: string): string {
  const relative = specifier.startsWith('./') || specifier.startsWith('../');
  if (!relative || !specifier.endsWith('.js')) {
    throw new Error(
      `Unsupported module specifier in ${fromFile}: ${specifier}`,
    );
  }
  return path.resolve(path.dirname(fromFile), `${specifier.slice(0, -3)}.ts`);
}

/**
 * Resolves the star re-export graph from `entryFile` and returns the sorted,
 * de-duplicated set of public export names. `readSource` is injectable so the
 * unit tests can supply a virtual file map.
 */
export function collectPublicNames(
  entryFile: string,
  readSource: (file: string) => string = (file) =>
    fs.readFileSync(file, 'utf8'),
): string[] {
  const names = new Set<string>();
  const visited = new Set<string>();
  const pending = [path.resolve(entryFile)];

  while (pending.length > 0) {
    const file = pending.pop()!;
    if (visited.has(file)) {
      continue;
    }
    visited.add(file);

    const {starSpecifiers, ownNames} = scanSource(file, readSource(file));
    for (const name of ownNames) {
      names.add(name);
    }
    for (const specifier of starSpecifiers) {
      pending.push(resolveStarSpecifier(file, specifier));
    }
  }

  // Default (UTF-16 code-unit) order, so the golden is byte-identical on every
  // operating system.
  return [...names].sort();
}

describe('scanSource', () => {
  it('collects a star re-export specifier', () => {
    expect(scanSource('a.ts', `export * from './a.js';`)).toEqual({
      starSpecifiers: ['./a.js'],
      ownNames: [],
    });
  });

  it('preserves duplicate star re-exports in source order', () => {
    const source = `export * from './b.js';\nexport * from './a.js';\nexport * from './b.js';`;

    expect(scanSource('a.ts', source).starSpecifiers).toEqual([
      './b.js',
      './a.js',
      './b.js',
    ]);
  });

  it('collects named re-exports under their exported alias', () => {
    expect(
      scanSource('a.ts', `export {A, B as C} from './m.js';`).ownNames,
    ).toEqual(['A', 'C']);
  });

  it('collects type-only re-exports', () => {
    expect(
      scanSource('a.ts', `export type {T} from './m.js';`).ownNames,
    ).toEqual(['T']);
  });

  it('collects a local named export with no from clause', () => {
    expect(
      scanSource('a.ts', `const Local = 1;\nexport {Local};`).ownNames,
    ).toEqual(['Local']);
  });

  it('collects every declarator of an exported variable statement', () => {
    expect(scanSource('a.ts', `export const a = 1, b = 2;`).ownNames).toEqual([
      'a',
      'b',
    ]);
  });

  it('collects exported functions', () => {
    const source = `export function f() {}\nexport async function g() {}`;

    expect(scanSource('a.ts', source).ownNames).toEqual(['f', 'g']);
  });

  it('collects exported classes', () => {
    const source = `export class C {}\nexport abstract class D {}`;

    expect(scanSource('a.ts', source).ownNames).toEqual(['C', 'D']);
  });

  it('collects exported types, interfaces and enums', () => {
    const source = `export interface I {}\nexport type T = string;\nexport enum E {A}`;

    expect(scanSource('a.ts', source).ownNames).toEqual(['I', 'T', 'E']);
  });

  it('ignores imports and non-exported declarations', () => {
    const source = `import {x} from './m.js';\nclass Hidden {}\nconst y = 1;\nsideEffect();`;

    expect(scanSource('a.ts', source)).toEqual({
      starSpecifiers: [],
      ownNames: [],
    });
  });

  it('rejects a default export', () => {
    expect(() => scanSource('a.ts', `export default class {}`)).toThrow(
      /Unsupported export syntax in a\.ts/,
    );
  });

  it('rejects an export assignment', () => {
    expect(() => scanSource('a.ts', `export = foo;`)).toThrow(
      /Unsupported export syntax in a\.ts/,
    );
  });

  it('rejects a namespace re-export', () => {
    expect(() => scanSource('a.ts', `export * as ns from './m.js';`)).toThrow(
      /Unsupported export syntax in a\.ts/,
    );
  });

  it('rejects a star export of a non-literal specifier', () => {
    expect(() => scanSource('a.ts', `export * from 5;`)).toThrow(
      /Unsupported export syntax in a\.ts/,
    );
  });

  it('rejects a destructured export', () => {
    expect(() => scanSource('a.ts', `export const {a} = obj;`)).toThrow(
      /Unsupported export syntax in a\.ts/,
    );
  });

  it('rejects an exported form it does not model', () => {
    expect(() => scanSource('a.ts', `export namespace N {}`)).toThrow(
      /Unsupported export syntax in a\.ts: ModuleDeclaration/,
    );
  });
});

describe('collectPublicNames', () => {
  const virtualDir = path.resolve('/virtual');
  const entry = path.resolve(virtualDir, 'entry.ts');

  function reader(files: Record<string, string>): (file: string) => string {
    return (file) => {
      const source = files[file];
      if (source === undefined) {
        expect.fail(`unexpected read of ${file}`);
      }
      return source;
    };
  }

  it('collects names across a star re-export hop', () => {
    const names = collectPublicNames(
      entry,
      reader({
        [entry]: `export const Direct = 1;\nexport * from './leaf.js';`,
        [path.resolve(virtualDir, 'leaf.ts')]: `export class Leaf {}`,
      }),
    );

    expect(names).toEqual(['Direct', 'Leaf']);
  });

  it('follows star re-exports transitively', () => {
    const names = collectPublicNames(
      entry,
      reader({
        [entry]: `export * from './mid.js';`,
        [path.resolve(virtualDir, 'mid.ts')]: `export * from './sub/leaf.js';`,
        [path.resolve(virtualDir, 'sub/leaf.ts')]: `export const Deep = 1;`,
      }),
    );

    expect(names).toEqual(['Deep']);
  });

  it('terminates on a cycle', () => {
    const names = collectPublicNames(
      entry,
      reader({
        [entry]: `export const A = 1;\nexport * from './other.js';`,
        [path.resolve(virtualDir, 'other.ts')]:
          `export const B = 2;\nexport * from './entry.js';`,
      }),
    );

    expect(names).toEqual(['A', 'B']);
  });

  it('reports a name exported by two files only once', () => {
    const names = collectPublicNames(
      entry,
      reader({
        [entry]: `export {Shared} from './one.js';\nexport * from './two.js';`,
        [path.resolve(virtualDir, 'one.ts')]: `export const Shared = 1;`,
        [path.resolve(virtualDir, 'two.ts')]: `export const Shared = 1;`,
      }),
    );

    expect(names).toEqual(['Shared']);
  });

  it('sorts with the default comparator, not a locale-aware one', () => {
    const names = collectPublicNames(
      entry,
      reader({[entry]: `export const b = 1, A = 2, a = 3, B = 4;`}),
    );

    expect(names).toEqual(['A', 'B', 'a', 'b']);
  });

  it('rejects a bare package specifier', () => {
    expect(() =>
      collectPublicNames(
        entry,
        reader({[entry]: `export * from '@scope/pkg/thing.js';`}),
      ),
    ).toThrow(/Unsupported module specifier/);
  });

  it('rejects a relative specifier without a .js extension', () => {
    expect(() =>
      collectPublicNames(entry, reader({[entry]: `export * from './m';`})),
    ).toThrow(/Unsupported module specifier/);
  });
});

describe('entry point star re-exports', () => {
  it.each(ENTRY_POINTS)('%s re-exports each module at most once', (name) => {
    const file = path.resolve(SRC_DIR, name);
    const {starSpecifiers} = scanSource(file, fs.readFileSync(file, 'utf8'));

    const counts = new Map<string, number>();
    for (const specifier of starSpecifiers) {
      counts.set(specifier, (counts.get(specifier) ?? 0) + 1);
    }
    const duplicated = [...counts]
      .filter(([, count]) => count > 1)
      .map(([specifier]) => specifier)
      .sort();

    expect(
      duplicated,
      `${name} star re-exports the same module more than once`,
    ).toEqual([]);
  });
});

describe('public export surface', () => {
  it('matches the checked-in golden', () => {
    const names = collectPublicNames(path.resolve(SRC_DIR, 'index.ts'));

    // Guards against blessing a golden produced by a walker that silently
    // stopped following the graph.
    expect(names.length).toBeGreaterThan(100);
    expect(names).toEqual(
      expect.arrayContaining([
        'Agent',
        'App',
        'BaseTool',
        'LlmAgent',
        'Runner',
      ]),
    );

    if (process.env.UPDATE_GOLDEN) {
      fs.writeFileSync(GOLDEN_PATH, `${JSON.stringify(names, null, 2)}\n`);
    }

    expect(names, REFRESH_INSTRUCTIONS).toEqual(
      JSON.parse(fs.readFileSync(GOLDEN_PATH, 'utf8')),
    );
  });
});
