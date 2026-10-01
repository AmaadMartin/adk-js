/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import {exec} from 'node:child_process';
import {readFileSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {promisify} from 'node:util';
import {beforeAll, describe, expect, it} from 'vitest';

const execAsync = promisify(exec);

const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));

/**
 * `npm pack` prints one entry per packed file. The `core` listing measures
 * 112 kB, so exec's 1 MB default leaves little headroom, and a truncated
 * stdout surfaces as an opaque JSON parse error rather than as a size error.
 */
const PACK_MAX_BUFFER_BYTES = 16 * 1024 * 1024;

/** Manifest fields other than `exports` that name a file. */
const SIMPLE_TARGET_FIELDS = [
  'main',
  'module',
  'browser',
  'types',
  'typings',
  'bin',
] as const;

/** A value in an `exports` map: a target, a fallback array, or conditions. */
type ExportsValue =
  | string
  | null
  | ExportsValue[]
  | {[key: string]: ExportsValue};

/** The manifest fields this suite reads. */
interface PackageManifest {
  name: string;
  private?: boolean;
  /** Workspace directories. Present on the repository root manifest only. */
  workspaces?: string[];
  main?: string;
  module?: string;
  browser?: string | Record<string, string | false>;
  types?: string;
  typings?: string;
  bin?: string | Record<string, string>;
  exports?: ExportsValue;
}

/** A manifest-relative file target and the manifest path that named it. */
interface ManifestTarget {
  /** For example `main`, `bin["adk"]` or `exports["."]["import"]`. */
  field: string;
  /** For example `./dist/esm/index.js`. */
  target: string;
}

/** The subset of `npm pack --json` this suite reads. */
interface PackReport {
  files: Array<{path: string}>;
}

/** A published workspace package and its directory. */
interface PublishedPackage {
  dir: string;
  manifest: PackageManifest;
}

function readManifest(dir: string): PackageManifest {
  const file = path.join(dir, 'package.json');
  return JSON.parse(readFileSync(file, 'utf8')) as PackageManifest;
}

/**
 * Appends every file target named under `value`, which is an `exports` map, a
 * condition object, a fallback array or a target string. A `null` target
 * blocks a subpath and names no file.
 */
function collectExportsTargets(
  value: ExportsValue | undefined,
  field: string,
  out: ManifestTarget[],
): void {
  if (typeof value === 'string') {
    out.push({field, target: value});
  } else if (Array.isArray(value)) {
    value.forEach((entry, index) => {
      collectExportsTargets(entry, `${field}[${index}]`, out);
    });
  } else if (value) {
    for (const [key, entry] of Object.entries(value)) {
      collectExportsTargets(entry, `${field}[${JSON.stringify(key)}]`, out);
    }
  }
}

/** Every file target a manifest names, in manifest field order. */
function collectTargets(manifest: PackageManifest): ManifestTarget[] {
  const targets: ManifestTarget[] = [];
  for (const field of SIMPLE_TARGET_FIELDS) {
    const value: string | Record<string, string | false> | undefined =
      manifest[field];
    if (typeof value === 'string') {
      targets.push({field, target: value});
    } else if (value) {
      for (const [key, entry] of Object.entries(value)) {
        if (typeof entry === 'string') {
          const label = `${field}[${JSON.stringify(key)}]`;
          targets.push({field: label, target: entry});
        }
      }
    }
  }
  collectExportsTargets(manifest.exports, 'exports', targets);
  // A target that names a file is always relative, which drops the `browser`
  // substitutions that disable a module or redirect it to another package.
  return targets.filter(({target}) => target.startsWith('./'));
}

/**
 * Whether the packed file list contains `target`.
 *
 * Every target in this repository names one file. A `*` subpath pattern fails
 * this lookup, which is the loud failure that asks for pattern support.
 */
function isPacked(target: string, packedFiles: ReadonlySet<string>): boolean {
  return packedFiles.has(target.replace(/^\.\//, ''));
}

/** The files `npm pack` would put in `dir`'s tarball, as POSIX paths. */
async function readPackedFiles(dir: string): Promise<Set<string>> {
  // `--ignore-scripts` pins the contract to the tree as built by
  // `npm run build`: without it, `npm pack` runs the package's own `prepack`.
  // Drop the flag if a `prepack` that generates published files is added.
  const {stdout} = await execAsync(
    'npm pack --dry-run --json --ignore-scripts',
    {cwd: dir, maxBuffer: PACK_MAX_BUFFER_BYTES},
  );
  const reports = JSON.parse(stdout) as PackReport[];
  return new Set(
    reports.flatMap((report) =>
      report.files.map((file) => file.path.replace(/\\/g, '/')),
    ),
  );
}

const PACKAGES: PublishedPackage[] = (readManifest(REPO_ROOT).workspaces ?? [])
  .map((workspace) => path.join(REPO_ROOT, workspace))
  .map((dir) => ({dir, manifest: readManifest(dir)}))
  .filter(({manifest}) => !manifest.private);

describe.each(PACKAGES)(
  '$manifest.name packed manifest targets',
  ({dir, manifest}: PublishedPackage) => {
    let packedFiles: ReadonlySet<string> = new Set();

    beforeAll(async () => {
      packedFiles = await readPackedFiles(dir);
      expect(
        [...packedFiles].some((file) => file.startsWith('dist/')),
        `${dir} packs no dist/ files; run "npm run build" before this suite`,
      ).toBe(true);
    });

    it.each(collectTargets(manifest))(
      'packs the file named by $field ($target)',
      ({field, target}: ManifestTarget) => {
        expect(
          isPacked(target, packedFiles),
          `${manifest.name} "${field}" names ${target}, which "npm pack" does not include`,
        ).toBe(true);
      },
    );
  },
);

describe('collectTargets', () => {
  const cases: Array<{
    name: string;
    manifest: PackageManifest;
    expected: ManifestTarget[];
  }> = [
    {
      name: 'reads the string form of exports',
      manifest: {name: 'sugar', exports: './dist/esm/index.js'},
      expected: [{field: 'exports', target: './dist/esm/index.js'}],
    },
    {
      name: 'reads conditions under a subpath and skips a null target',
      manifest: {
        name: 'conditions',
        exports: {'./sub': {import: './dist/esm/sub.js', default: null}},
      },
      expected: [
        {field: 'exports["./sub"]["import"]', target: './dist/esm/sub.js'},
      ],
    },
    {
      name: 'reads every entry of a fallback array',
      manifest: {name: 'fallback', exports: {'.': ['./a.js', './b.js']}},
      expected: [
        {field: 'exports["."][0]', target: './a.js'},
        {field: 'exports["."][1]', target: './b.js'},
      ],
    },
    {
      name: 'drops browser substitutions that name no file',
      manifest: {
        name: 'browser-map',
        browser: {'./node.js': './browser.js', stream: false, buf: 'buffer'},
      },
      expected: [{field: 'browser["./node.js"]', target: './browser.js'}],
    },
    {
      name: 'reads the simple fields and the bin map',
      manifest: {
        name: '@google/adk-devtools',
        main: './dist/cjs/index.js',
        module: './dist/esm/index.js',
        typings: './dist/types/index.d.ts',
        bin: {adk: './dist/esm/cli_entrypoint.js'},
      },
      expected: [
        {field: 'main', target: './dist/cjs/index.js'},
        {field: 'module', target: './dist/esm/index.js'},
        {field: 'typings', target: './dist/types/index.d.ts'},
        {field: 'bin["adk"]', target: './dist/esm/cli_entrypoint.js'},
      ],
    },
  ];

  it.each(cases)('$name', ({manifest, expected}) => {
    expect(collectTargets(manifest)).toEqual(expected);
  });
});

describe('isPacked', () => {
  const PACKED_FIXTURE: ReadonlySet<string> = new Set([
    'package.json',
    'dist/esm/index.js',
    'dist/cjs/index.js',
    'dist/types/index.d.ts',
  ]);

  it.each([
    {target: './dist/esm/index.js', expected: true},
    {target: 'dist/esm/index.js', expected: true},
    {target: './dist/web/index_web.js', expected: false},
  ])('$target is packed: $expected', ({target, expected}) => {
    expect(isPacked(target, PACKED_FIXTURE)).toBe(expected);
  });
});
