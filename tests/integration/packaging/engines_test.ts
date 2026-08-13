/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {minVersion, satisfies} from 'semver';
import {beforeAll, describe, expect, it} from 'vitest';

/**
 * Workspace directories whose package.json is published to npm. The root
 * manifest is excluded: it is the workspace container, not a deliverable.
 */
const PUBLISHED_WORKSPACES = ['core', 'dev', 'integrations'];

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

interface Manifest {
  name?: string;
  engines?: {node?: string};
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

/** Reads a workspace manifest; `.` reads the workspace root manifest. */
async function readManifest(workspace: string): Promise<Manifest> {
  const manifestPath = path.join(process.cwd(), workspace, 'package.json');
  return JSON.parse(await readFile(manifestPath, 'utf8')) as Manifest;
}

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

describe('published package manifests', () => {
  it.each(PUBLISHED_WORKSPACES)(
    '%s declares the shared engines.node range',
    async (workspace) => {
      const manifest = await readManifest(workspace);
      expect(manifest.engines?.node).toBe(EXPECTED_NODE_RANGE);
    },
  );

  it('leaves engines off the workspace root', async () => {
    // Only core, dev and integrations are published, so a floor declared on
    // the workspace container would reach no consumer.
    expect((await readManifest('.')).engines).toBeUndefined();
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
  it.each(PUBLISHED_WORKSPACES)(
    '%s declares a floor every runtime dependency accepts',
    async (workspace) => {
      const declared = (await readManifest(workspace)).engines?.node;
      const floor = declared === undefined ? null : minVersion(declared);
      if (floor === null) {
        expect.fail(
          `${workspace}/package.json declares engines.node ` +
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
          `published manifests (${PUBLISHED_WORKSPACES.join(', ')})`,
      ).toEqual([]);
    },
  );
});
