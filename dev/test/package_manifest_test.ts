/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import fg from 'fast-glob';
import {readFileSync} from 'node:fs';
import {builtinModules} from 'node:module';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import ts from 'typescript';
import {describe, expect, it} from 'vitest';

const DEV_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
);
const REPO_ROOT = path.dirname(DEV_ROOT);
const BUILT_INS = new Set(builtinModules);

interface PackageManifest {
  dependencies: Record<string, string>;
  devDependencies: Record<string, string>;
}

/** A non-relative module specifier, tagged with where it was written. */
interface ImportRef {
  specifier: string;
  /** Repo-relative `file:line`, so a failure points straight at the source. */
  at: string;
}

/** `@scope/name/deep/path` -> `@scope/name`; `name/deep/path` -> `name`. */
function packageRoot(specifier: string): string {
  const [first, second] = specifier.split('/');
  return first.startsWith('@') ? `${first}/${second}` : first;
}

/** True for a built-in written without the scheme, e.g. `fs`, `fs/promises`. */
function isBareBuiltIn(specifier: string): boolean {
  return (
    !specifier.startsWith('node:') && BUILT_INS.has(specifier.split('/')[0])
  );
}

/** The string literal naming the module an import/export/`import()` targets. */
function moduleSpecifierOf(node: ts.Node): ts.StringLiteralLike | undefined {
  if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
    const {moduleSpecifier} = node;
    return moduleSpecifier && ts.isStringLiteralLike(moduleSpecifier)
      ? moduleSpecifier
      : undefined;
  }
  if (
    ts.isCallExpression(node) &&
    node.expression.kind === ts.SyntaxKind.ImportKeyword
  ) {
    const [argument] = node.arguments;
    return argument && ts.isStringLiteralLike(argument) ? argument : undefined;
  }
  if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) {
    const {literal} = node.argument;
    return ts.isStringLiteralLike(literal) ? literal : undefined;
  }
  return undefined;
}

/** Every non-relative specifier in `file`, found by parsing, not by regex. */
function collectImports(file: string): ImportRef[] {
  const source = ts.createSourceFile(
    file,
    readFileSync(file, 'utf8'),
    ts.ScriptTarget.Latest,
  );
  const refs: ImportRef[] = [];
  const pending: ts.Node[] = [source];
  for (let node = pending.pop(); node; node = pending.pop()) {
    const literal = moduleSpecifierOf(node);
    if (literal && !literal.text.startsWith('.')) {
      const {line} = source.getLineAndCharacterOfPosition(
        literal.getStart(source),
      );
      refs.push({
        specifier: literal.text,
        at: `${path.relative(REPO_ROOT, file)}:${line + 1}`,
      });
    }
    ts.forEachChild(node, (child) => {
      pending.push(child);
    });
  }
  return refs;
}

const imports: ImportRef[] = fg
  .sync('**/*.ts', {cwd: path.join(DEV_ROOT, 'src'), absolute: true})
  .flatMap(collectImports);

const manifest: PackageManifest = JSON.parse(
  readFileSync(path.join(DEV_ROOT, 'package.json'), 'utf8'),
);

describe('dev/package.json', () => {
  it('declares every package imported by dev/src', () => {
    // dev/build.js bundles nothing (packages:'external'), so these specifiers
    // survive verbatim into the published dist and have to resolve from a
    // consumer's own install rather than from whatever npm hoists for core.
    // devDependencies deliberately does not count: shipped source must not
    // import a dev-only package.
    const undeclared = imports
      .filter(
        ({specifier}) =>
          !specifier.startsWith('node:') && !isBareBuiltIn(specifier),
      )
      .filter(
        ({specifier}) => !(packageRoot(specifier) in manifest.dependencies),
      )
      .map(({specifier, at}) => `${packageRoot(specifier)} (${at})`);

    expect(undeclared).toEqual([]);
  });

  it('imports Node built-ins with the node: prefix', () => {
    const unprefixed = imports
      .filter(({specifier}) => isBareBuiltIn(specifier))
      .map(({specifier, at}) => `${specifier} (${at})`);

    expect(unprefixed).toEqual([]);
  });
});
