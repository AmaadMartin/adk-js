/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import {readFileSync} from 'node:fs';
import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {minVersion, satisfies} from 'semver';
import {beforeAll, describe, expect, it} from 'vitest';

/**
 * The consumer-facing Node.js floor, and the exact intersection of the
 * `engines.node` ranges in the runtime dependency closure: Node 20.5.0 is
 * rejected by 27 `@opentelemetry/*` packages declaring
 * `^18.19.0 || >=20.6.0`, and 20.6.0 satisfies every range in that closure.
 *
 * Asserting the literal pins the floor from above, so changing the published
 * support statement is an explicit, reviewed edit rather than an incidental
 * one. The lockfile check below pins it from below.
 */
const EXPECTED_NODE_RANGE = '>=20.6.0';

/**
 * A manifest that is installed but never published. Fixtures inherit the
 * repository's Node floor through the workspace they link against, so a floor
 * of their own would only drift.
 */
const UNPUBLISHED_FIXTURE = 'tests/integration/build_setup/ts_esm';

interface Manifest {
  name?: string;
  engines?: {node?: string};
  workspaces?: string[];
}

interface LockfileEntry {
  dev?: boolean;
  engines?: {node?: string};
}

interface Lockfile {
  packages: Record<string, LockfileEntry>;
}

/** An `engines.node` range together with the lockfile path that declares it. */
interface EngineConstraint {
  path: string;
  range: string;
}

/**
 * Reads a manifest relative to the repository root; `.` reads the root
 * manifest. Synchronous because `it.each` needs the workspace list below at
 * collection time.
 */
function readManifest(dir: string): Manifest {
  const manifestPath = path.join(process.cwd(), dir, 'package.json');
  return JSON.parse(readFileSync(manifestPath, 'utf8')) as Manifest;
}

/**
 * Every manifest that must declare the floor: the workspace root, plus the
 * workspaces it declares.
 *
 * Derived from the root manifest rather than hardcoded, so a workspace added
 * later is held to the same invariant without anyone remembering to edit this
 * file. The root is included because npm evaluates a project's own
 * `engines` during `npm install`, which is how a contributor on an
 * unsupported Node learns about it before CI does.
 */
const MANIFEST_DIRS = ['.', ...(readManifest('.').workspaces ?? [])];

async function readLockfile(): Promise<Lockfile> {
  const lockfilePath = path.join(process.cwd(), 'package-lock.json');
  return JSON.parse(await readFile(lockfilePath, 'utf8')) as Lockfile;
}

/**
 * The `engines.node` ranges a consumer inherits by installing these packages.
 *
 * Only paths under a `node_modules/` directory are considered, which drops the
 * workspace entries npm records for `core`/`dev`/`integrations` themselves —
 * their ranges are the value under test, not a constraint on it.
 *
 * Only `dev` is filtered out, never `devOptional`: npm uses the latter flag
 * when a package is reachable through a runtime path as well as a dev one, so
 * a consumer does inherit its constraint.
 */
function runtimeEngineConstraints(lockfile: Lockfile): EngineConstraint[] {
  return Object.entries(lockfile.packages).flatMap(([entryPath, entry]) => {
    const range = entry.engines?.node;
    return entry.dev === true ||
      range === undefined ||
      !entryPath.includes('node_modules/')
      ? []
      : [{path: entryPath, range}];
  });
}

describe('package manifests', () => {
  it('derives the manifest list from the root workspaces array', () => {
    // Guards the assertions below: an empty derived list would make every
    // `it.each` over it vacuous instead of failing.
    expect(MANIFEST_DIRS).toEqual(
      expect.arrayContaining(['.', 'core', 'dev', 'integrations']),
    );
  });

  it.each(MANIFEST_DIRS)('%s declares the shared engines.node range', (dir) => {
    expect(readManifest(dir).engines?.node).toBe(EXPECTED_NODE_RANGE);
  });

  it('leaves engines off unpublished test fixtures', () => {
    expect(readManifest(UNPUBLISHED_FIXTURE).engines).toBeUndefined();
  });
});

describe('declared Node.js floor vs. the committed lockfile', () => {
  let constraints: EngineConstraint[];

  beforeAll(async () => {
    constraints = runtimeEngineConstraints(await readLockfile());
  });

  it('reads runtime engine constraints out of package-lock.json', () => {
    expect(constraints).not.toHaveLength(0);
  });

  /**
   * Deliberately one-sided: this asserts the declared floor is not too *low*,
   * which is the direction that breaks consumers. It does not assert the floor
   * is tight, so a dependency loosening its own range never forces a manifest
   * edit here, and a maintainer stays free to declare a stricter floor than
   * the dependency closure strictly requires.
   */
  it.each(MANIFEST_DIRS)(
    '%s declares a floor every runtime dependency accepts',
    (dir) => {
      const declared = readManifest(dir).engines?.node;
      const floor = declared === undefined ? null : minVersion(declared);
      if (floor === null) {
        expect.fail(
          `${dir}/package.json declares engines.node ` +
            `${JSON.stringify(declared)}, which is not a satisfiable ` +
            'semver range',
        );
      }
      const offenders = constraints
        .filter(({range}) => !satisfies(floor.version, range))
        .map(({path: entryPath, range}) => `${entryPath} requires ${range}`);
      expect(
        offenders,
        `engines.node ${declared} admits Node ${floor.version}, which the ` +
          'listed runtime dependencies reject. Raise engines.node in the ' +
          `declaring manifests (${MANIFEST_DIRS.join(', ')})`,
      ).toEqual([]);
    },
  );
});
