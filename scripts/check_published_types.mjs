/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Fails when a published package's declaration files reference a module that
 * package does not list in its `dependencies`.
 *
 * Every publishable workspace is packed with `npm pack`, the tarballs are
 * installed into a throwaway consumer project, and that project is
 * type-checked. Three properties make the check meaningful; each one defeats a
 * reason the repository's other checks cannot see this class of defect:
 *
 * - The scratch project lives under the OS temp directory, never inside the
 *   repository. npm hoists every workspace dependency into the repo-root
 *   `node_modules`, so anything type-checked from a path inside the repo walks
 *   up into that directory and resolves types a consumer never receives.
 * - It installs packed tarballs, not `file:` links to the workspace
 *   directories, so what gets installed is the declared `dependencies`
 *   closure rather than the development tree.
 * - `skipLibCheck` is false. With it on, an unresolvable module inside a
 *   dependency's `.d.ts` degrades silently to `any` and this check passes on a
 *   broken tree.
 *
 * `@types/node` belongs to the probe's toolchain rather than to any package's
 * `dependencies`: published declarations do reference Node globals, but every
 * Node TypeScript consumer already installs `@types/node`, and pinning its
 * major from a library is a known source of consumer version conflicts.
 *
 * The verdict is the one a consumer sees, not a per-package one. All packages
 * are installed side by side, so hoisting lets one workspace's declared
 * dependency satisfy a sibling workspace's undeclared import. Per-package
 * declaration hygiene is not enforced here.
 */

import {execFileSync} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
);

/** Diagnostics meaning "a module in the published closure did not resolve". */
const UNRESOLVED_MODULE_CODES = new Set(['TS2307', 'TS7016']);

const DIAGNOSTIC_PATTERN = /error (TS\d+):/;

const PROBE_TSCONFIG = {
  compilerOptions: {
    target: 'ES2022',
    module: 'nodenext',
    moduleResolution: 'nodenext',
    strict: true,
    noEmit: true,
    skipLibCheck: false,
    types: ['node'],
  },
  include: ['src/**/*.ts'],
};

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

/**
 * Runs npm. `npm run` exports npm's own CLI entry point as `npm_execpath`;
 * invoking that with the current node binary keeps this working on Windows,
 * where npm is `npm.cmd` and `execFileSync` cannot spawn it directly.
 */
function npm(args, cwd) {
  const npmCli = process.env.npm_execpath;
  return npmCli
    ? execFileSync(process.execPath, [npmCli, ...args], {cwd, encoding: 'utf8'})
    : execFileSync('npm', args, {cwd, encoding: 'utf8'});
}

/** Publishable workspaces, as `{name, dir}` pairs. */
function publishablePackages() {
  const {workspaces} = readJson(path.join(REPO_ROOT, 'package.json'));
  const packages = [];
  for (const workspace of workspaces) {
    const dir = path.join(REPO_ROOT, workspace);
    const manifest = readJson(path.join(dir, 'package.json'));
    if (!manifest.private) {
      packages.push({name: manifest.name, dir});
    }
  }
  return packages;
}

function assertBuilt(packages) {
  for (const {dir} of packages) {
    const declarations = path.join(dir, 'dist', 'types', 'index.d.ts');
    if (!fs.existsSync(declarations)) {
      const relative = path.relative(REPO_ROOT, declarations);
      throw new Error(`${relative} not found; run \`npm run build\` first.`);
    }
  }
}

/**
 * `typescript` and `@types/node` at the repository's own ranges, so the probe's
 * toolchain cannot drift from the one the packages are built with.
 */
function toolchainSpecs() {
  const {devDependencies} = readJson(path.join(REPO_ROOT, 'package.json'));
  return ['typescript', '@types/node'].map(
    (name) => `${name}@${devDependencies[name]}`,
  );
}

/**
 * The tarball directory is read back rather than `npm pack --json` parsed: npm
 * writes notices to stderr and the JSON shape has moved between majors.
 */
function packAll(packages, tarballDir) {
  fs.mkdirSync(tarballDir, {recursive: true});
  for (const {dir} of packages) {
    npm(['pack', '--pack-destination', tarballDir, '--loglevel=error'], dir);
  }
  return fs
    .readdirSync(tarballDir)
    .filter((entry) => entry.endsWith('.tgz'))
    .map((entry) => path.join(tarballDir, entry));
}

function probeFileName(packageName) {
  return packageName.replace(/[^a-z0-9]+/gi, '_').replace(/^_|_$/g, '');
}

function writeProbeProject(scratchDir, packages) {
  fs.writeFileSync(
    path.join(scratchDir, 'package.json'),
    JSON.stringify({
      name: 'adk-published-types-probe',
      private: true,
      version: '0.0.0',
      type: 'module',
    }),
  );
  fs.writeFileSync(
    path.join(scratchDir, 'tsconfig.json'),
    JSON.stringify(PROBE_TSCONFIG),
  );
  const srcDir = path.join(scratchDir, 'src');
  fs.mkdirSync(srcDir);
  for (const {name} of packages) {
    // `export type Probe` is load-bearing: with the namespace unused the import
    // is elided and the package's declaration graph is never pulled in.
    fs.writeFileSync(
      path.join(srcDir, `${probeFileName(name)}.ts`),
      `import * as pkg from '${name}';\nexport type Probe = typeof pkg;\n`,
    );
  }
}

/**
 * `--legacy-peer-deps` is deliberate: core declares five `@mikro-orm/*` drivers
 * as non-optional peers, and which database driver a consumer picks is not part
 * of the `dependencies` closure under test here.
 */
function installClosure(scratchDir, tarballs) {
  npm(
    [
      'install',
      ...tarballs,
      ...toolchainSpecs(),
      '--no-audit',
      '--no-fund',
      '--legacy-peer-deps',
      '--loglevel=error',
    ],
    scratchDir,
  );
}

function typecheck(scratchDir) {
  const tsc = path.join(scratchDir, 'node_modules', 'typescript', 'bin', 'tsc');
  const args = [tsc, '--noEmit', '-p', 'tsconfig.json'];
  try {
    return execFileSync(process.execPath, args, {
      cwd: scratchDir,
      encoding: 'utf8',
    });
  } catch (error) {
    // tsc exits non-zero for any diagnostic, so diagnostics on stdout are the
    // result. An empty stdout means tsc itself failed to run.
    if (error.stdout) {
      return error.stdout;
    }
    throw error;
  }
}

/**
 * Only unresolved-module diagnostics decide the verdict. Any other type error
 * inside a dependency's own declarations is somebody else's bug and must not
 * redden this job.
 */
function unresolvedModuleDiagnostics(diagnostics) {
  return diagnostics
    .split('\n')
    .filter((line) =>
      UNRESOLVED_MODULE_CODES.has(DIAGNOSTIC_PATTERN.exec(line)?.[1]),
    )
    .map((line) => line.trim());
}

function removeScratchDir(scratchDir) {
  try {
    fs.rmSync(scratchDir, {recursive: true, force: true, maxRetries: 3});
  } catch (error) {
    // Cleanup must never mask the verdict the check just produced.
    process.stderr.write(`Could not remove ${scratchDir}: ${error.message}\n`);
  }
}

function main() {
  const packages = publishablePackages();
  assertBuilt(packages);

  const scratchDir = fs.mkdtempSync(
    path.join(os.tmpdir(), 'adk-published-types-'),
  );
  let diagnostics;
  try {
    const tarballs = packAll(packages, path.join(scratchDir, 'tarballs'));
    writeProbeProject(scratchDir, packages);
    installClosure(scratchDir, tarballs);
    diagnostics = typecheck(scratchDir);
  } finally {
    removeScratchDir(scratchDir);
  }

  const unresolved = unresolvedModuleDiagnostics(diagnostics);
  if (unresolved.length > 0) {
    const listed = unresolved.map((line) => `  ${line}`).join('\n');
    process.stdout.write(
      `Published declarations reference modules the packages do not ` +
        `declare:\n${listed}\nMove each missing package into the ` +
        `"dependencies" of the workspace owning the dist/types file above.\n`,
    );
    process.exit(1);
  }
  const names = packages.map(({name}) => name).join(', ');
  process.stdout.write(`Published type closure resolves for: ${names}.\n`);
}

main();
