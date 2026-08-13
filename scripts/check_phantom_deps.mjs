/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Fails when a first-party file imports a package that is declared in no
 * package.json on its Node resolution path.
 *
 * Such a package ("phantom dependency") only resolves inside this monorepo,
 * because npm workspaces hoist a sibling workspace's dependency into the
 * repo-root node_modules. It breaks for everyone else.
 *
 * Usage: node scripts/check_phantom_deps.mjs [rootDir]
 */

import fs from 'node:fs';
import {builtinModules} from 'node:module';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import ts from 'typescript';

const MANIFEST_FILENAME = 'package.json';

/** POSIX-relative on purpose: it is printed verbatim in the report. */
const ALLOWLIST_RELATIVE_PATH = 'scripts/phantom_deps_allowlist.json';

/** How each scanned extension must be parsed by the TypeScript compiler. */
const SCRIPT_KINDS_BY_EXTENSION = new Map([
  ['.ts', ts.ScriptKind.TS],
  ['.tsx', ts.ScriptKind.TSX],
  ['.js', ts.ScriptKind.JS],
  ['.mjs', ts.ScriptKind.JS],
  ['.cjs', ts.ScriptKind.JS],
]);

/** Build output, dependencies and caches: never first-party sources. */
const SKIPPED_DIRECTORY_NAMES = new Set([
  '.adk_build_cache',
  '.cache',
  '.git',
  'api-reference',
  'coverage',
  'dist',
  'node_modules',
]);

/** Every manifest field npm resolves a bare specifier through. */
const MANIFEST_DEPENDENCY_FIELDS = [
  'dependencies',
  'devDependencies',
  'peerDependencies',
  'optionalDependencies',
];

const NODE_BUILTIN_SPECIFIERS = new Set(builtinModules);
const REQUIRE_IDENTIFIER = 'require';

/**
 * Orders strings by UTF-16 code unit so the report is byte-identical on every
 * platform and locale. `localeCompare` is not.
 */
function compareStrings(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Identity of a (manifest, package) pair. Neither part can contain NUL. */
function violationKey(manifest, packageName) {
  return `${manifest}\u0000${packageName}`;
}

/** Repo-relative path with `/` separators, on Windows too. */
function toRepoRelative(filePath, rootDir) {
  return path.relative(rootDir, filePath).split(path.sep).join('/');
}

/** Parsed JSON object at `filePath`; throws naming the file if it is not one. */
function readJsonObject(filePath) {
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (cause) {
    throw new Error(`Unable to read ${filePath}`, {cause});
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`Unable to read ${filePath}: expected a JSON object`);
  }
  return parsed;
}

/** Every source file under `rootDir`, skipping generated directories. */
function collectSourceFiles(rootDir) {
  const files = [];
  const pending = [rootDir];
  while (pending.length > 0) {
    const directory = pending.pop();
    for (const entry of fs.readdirSync(directory, {withFileTypes: true})) {
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        if (!SKIPPED_DIRECTORY_NAMES.has(entry.name)) {
          pending.push(entryPath);
        }
      } else if (
        entry.isFile() &&
        SCRIPT_KINDS_BY_EXTENSION.has(path.extname(entry.name))
      ) {
        files.push(entryPath);
      }
    }
  }
  return files;
}

/**
 * Text of `node` when it is a plain string literal.
 *
 * This is the guard that makes the check AST-based rather than textual: a
 * template literal with substitutions, or an identifier, yields null and is
 * skipped rather than guessed at.
 */
function literalTextOf(node) {
  return node !== undefined && ts.isStringLiteralLike(node) ? node.text : null;
}

/** True for `import(...)`, `require(...)` and `require.resolve(...)`. */
function isModuleLoadingCallee(expression) {
  if (expression.kind === ts.SyntaxKind.ImportKeyword) {
    return true;
  }
  if (ts.isIdentifier(expression)) {
    return expression.text === REQUIRE_IDENTIFIER;
  }
  return (
    ts.isPropertyAccessExpression(expression) &&
    ts.isIdentifier(expression.expression) &&
    expression.expression.text === REQUIRE_IDENTIFIER &&
    expression.name.text === 'resolve'
  );
}

/** The module specifier `node` loads, or null when it loads none. */
function literalSpecifierOf(node) {
  if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
    return literalTextOf(node.moduleSpecifier);
  }
  if (
    ts.isImportEqualsDeclaration(node) &&
    ts.isExternalModuleReference(node.moduleReference)
  ) {
    return literalTextOf(node.moduleReference.expression);
  }
  if (ts.isCallExpression(node) && isModuleLoadingCallee(node.expression)) {
    return literalTextOf(node.arguments[0]);
  }
  if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) {
    return literalTextOf(node.argument.literal);
  }
  return null;
}

function collectSpecifiers(node, specifiers) {
  const specifier = literalSpecifierOf(node);
  if (specifier !== null) {
    specifiers.add(specifier);
  }
  ts.forEachChild(node, (child) => collectSpecifiers(child, specifiers));
}

/**
 * Every literal module specifier in `filePath`.
 *
 * Syntax errors are not reported: `ts.createSourceFile` returns a best-effort
 * tree, and recovering the specifiers it did parse is more useful here than
 * becoming a second type-checker.
 */
function extractModuleSpecifiers(filePath) {
  const sourceFile = ts.createSourceFile(
    filePath,
    fs.readFileSync(filePath, 'utf8'),
    ts.ScriptTarget.Latest,
    /* setParentNodes= */ false,
    SCRIPT_KINDS_BY_EXTENSION.get(path.extname(filePath)),
  );
  const specifiers = new Set();
  collectSpecifiers(sourceFile, specifiers);
  return specifiers;
}

function isNodeBuiltin(specifier) {
  return (
    specifier.startsWith('node:') || NODE_BUILTIN_SPECIFIERS.has(specifier)
  );
}

/**
 * The npm package a specifier resolves against, or null when the specifier
 * names no package (relative, absolute, subpath import, or a lone `@scope`).
 */
function packageNameFromSpecifier(specifier) {
  // `path.win32` rather than `path.isAbsolute`, which recognises `C:\` only
  // when the check itself runs on Windows and would therefore make the report
  // differ between CI's three operating systems.
  if (
    specifier.startsWith('.') ||
    specifier.startsWith('#') ||
    path.win32.isAbsolute(specifier)
  ) {
    return null;
  }
  const segments = specifier.split('/');
  if (specifier.startsWith('@')) {
    return segments[1] ? `${segments[0]}/${segments[1]}` : null;
  }
  return segments[0] || null;
}

/** Parsed manifest fields, cached because ancestors are revisited per file. */
function readManifest(manifestPath, manifestCache) {
  const cached = manifestCache.get(manifestPath);
  if (cached) {
    return cached;
  }
  const parsed = readJsonObject(manifestPath);
  const dependencies = new Set();
  for (const field of MANIFEST_DEPENDENCY_FIELDS) {
    for (const name of Object.keys(parsed[field] ?? {})) {
      dependencies.add(name);
    }
  }
  const manifest = {
    name: parsed.name,
    dependencies,
    workspaces: parsed.workspaces ?? [],
  };
  manifestCache.set(manifestPath, manifest);
  return manifest;
}

/**
 * Every package.json from `filePath`'s directory up to and including
 * `rootDir` — the chain Node itself walks looking for node_modules.
 */
function* manifestChain(filePath, rootDir) {
  let directory = path.dirname(filePath);
  for (;;) {
    const manifestPath = path.join(directory, MANIFEST_FILENAME);
    if (fs.existsSync(manifestPath)) {
      yield manifestPath;
    }
    if (directory === rootDir) {
      return;
    }
    directory = path.dirname(directory);
  }
}

/**
 * The manifest a missing dependency should be added to: the nearest enclosing
 * one, falling back to the root manifest when the file has no enclosing
 * package.json at all.
 */
function findNearestManifest(filePath, rootDir) {
  const {value: manifestPath} = manifestChain(filePath, rootDir).next();
  return manifestPath
    ? toRepoRelative(manifestPath, rootDir)
    : MANIFEST_FILENAME;
}

function isDeclaredOnResolutionPath(
  filePath,
  packageName,
  rootDir,
  manifestCache,
) {
  for (const manifestPath of manifestChain(filePath, rootDir)) {
    if (
      readManifest(manifestPath, manifestCache).dependencies.has(packageName)
    ) {
      return true;
    }
  }
  return false;
}

/**
 * Names of the workspace packages, which npm links into the root node_modules
 * and which are therefore always resolvable.
 */
function readWorkspacePackageNames(rootDir, manifestCache) {
  const names = new Set();
  const rootManifestPath = path.join(rootDir, MANIFEST_FILENAME);
  if (!fs.existsSync(rootManifestPath)) {
    return names;
  }
  const rootManifest = readManifest(rootManifestPath, manifestCache);
  if (rootManifest.name) {
    names.add(rootManifest.name);
  }
  // simplicity: workspace entries are read as literal directories, which is
  // all adk-js declares. Expand globs here if a `packages/*` entry is added.
  for (const workspace of rootManifest.workspaces) {
    const manifestPath = path.join(rootDir, workspace, MANIFEST_FILENAME);
    if (!fs.existsSync(manifestPath)) {
      continue;
    }
    const {name} = readManifest(manifestPath, manifestCache);
    if (name) {
      names.add(name);
    }
  }
  return names;
}

/** Every (package, nearest manifest) pair that is imported but undeclared. */
function findPhantomDependencies(rootDir) {
  const manifestCache = new Map();
  const workspaceNames = readWorkspacePackageNames(rootDir, manifestCache);
  const groups = new Map();
  for (const filePath of collectSourceFiles(rootDir)) {
    for (const specifier of extractModuleSpecifiers(filePath)) {
      if (isNodeBuiltin(specifier)) {
        continue;
      }
      const packageName = packageNameFromSpecifier(specifier);
      if (packageName === null || workspaceNames.has(packageName)) {
        continue;
      }
      if (
        isDeclaredOnResolutionPath(
          filePath,
          packageName,
          rootDir,
          manifestCache,
        )
      ) {
        continue;
      }
      const manifest = findNearestManifest(filePath, rootDir);
      const key = violationKey(manifest, packageName);
      let group = groups.get(key);
      if (!group) {
        group = {packageName, manifest, files: new Set()};
        groups.set(key, group);
      }
      group.files.add(toRepoRelative(filePath, rootDir));
    }
  }
  return [...groups.values()]
    .map(({packageName, manifest, files}) => ({
      packageName,
      manifest,
      files: [...files].sort(),
    }))
    .sort(
      (a, b) =>
        compareStrings(a.packageName, b.packageName) ||
        compareStrings(a.manifest, b.manifest),
    );
}

/** Tolerated pre-existing violations, as manifest path -> package names. */
function readAllowlist(rootDir) {
  const allowlistPath = path.join(rootDir, ALLOWLIST_RELATIVE_PATH);
  const allowlist = new Map();
  if (!fs.existsSync(allowlistPath)) {
    return allowlist;
  }
  for (const [manifest, packageNames] of Object.entries(
    readJsonObject(allowlistPath),
  )) {
    if (!Array.isArray(packageNames)) {
      throw new Error(
        `Unable to read ${allowlistPath}: "${manifest}" must map to an array`,
      );
    }
    allowlist.set(manifest, new Set(packageNames));
  }
  return allowlist;
}

/**
 * Splits violations into the ones still worth reporting and the allowlist
 * entries that no longer match anything. Stale entries fail the check too, so
 * the allowlist can only ever shrink.
 */
function applyAllowlist(violations, allowlist) {
  const seen = new Set(
    violations.map(({manifest, packageName}) =>
      violationKey(manifest, packageName),
    ),
  );
  const staleEntries = [];
  for (const [manifest, packageNames] of allowlist) {
    for (const packageName of packageNames) {
      if (!seen.has(violationKey(manifest, packageName))) {
        staleEntries.push({manifest, packageName});
      }
    }
  }
  return {
    reported: violations.filter(
      ({manifest, packageName}) => !allowlist.get(manifest)?.has(packageName),
    ),
    staleEntries: staleEntries.sort(
      (a, b) =>
        compareStrings(a.manifest, b.manifest) ||
        compareStrings(a.packageName, b.packageName),
    ),
  };
}

function formatReport(reported, staleEntries) {
  if (reported.length === 0 && staleEntries.length === 0) {
    return '✅ No phantom dependencies found.\n';
  }
  const lines = [];
  for (const {packageName, manifest, files} of reported) {
    lines.push(packageName, `  declare it in: ${manifest}`, '  imported by:');
    for (const file of files) {
      lines.push(`    ${file}`);
    }
    lines.push('');
  }
  if (reported.length > 0) {
    const noun = reported.length === 1 ? 'dependency' : 'dependencies';
    lines.push(
      `✖ Found ${reported.length} undeclared ${noun}.`,
      '  Add each package above to the package.json named under it.',
      '',
    );
  }
  if (staleEntries.length > 0) {
    lines.push(
      '✖ Allowlist entry is no longer needed.',
      `  These entries in ${ALLOWLIST_RELATIVE_PATH} match no violation and`,
      '  must be removed:',
    );
    for (const {manifest, packageName} of staleEntries) {
      lines.push(`    ${manifest}: ${packageName}`);
    }
    lines.push('');
  }
  return lines.join('\n');
}

/** Writes the report and returns the process exit code. */
function main(rootDir) {
  const {reported, staleEntries} = applyAllowlist(
    findPhantomDependencies(rootDir),
    readAllowlist(rootDir),
  );
  process.stdout.write(formatReport(reported, staleEntries));
  return reported.length === 0 && staleEntries.length === 0 ? 0 : 1;
}

const [, , rootDirArgument] = process.argv;

process.exitCode = main(
  rootDirArgument
    ? path.resolve(rootDirArgument)
    : path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'),
);
