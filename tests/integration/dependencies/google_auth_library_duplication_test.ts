/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {describe, expect, it} from 'vitest';

const PKG = 'google-auth-library';
const LOCKFILE = 'package-lock.json';
const DOC = 'docs/dependency-duplication.md';
const HOISTED_PATH = `node_modules/${PKG}`;
const NESTED_SUFFIX = `/node_modules/${PKG}`;

/** A nested `google-auth-library` copy that is knowingly kept, and why. */
interface AllowedDuplicate {
  /** Package whose declared range forces the nested copy. */
  readonly dependent: string;
  /** The `google-auth-library` range that `dependent` declares. */
  readonly declaredRange: string;
  /**
   * False for rows owned by another in-flight change, which may legally vanish
   * from the lockfile without this test being updated.
   */
  readonly required: boolean;
  /** One-line rationale, expanded in `docs/dependency-duplication.md`. */
  readonly reason: string;
}

const ALLOWED_DUPLICATES: readonly AllowedDuplicate[] = [
  {
    dependent: '@google-cloud/storage',
    declaredRange: '^9.6.3',
    required: true,
    reason:
      'v10 authorizeRequest() ignores the `uri` this package sends, and teeny-request writes to its Headers result never reach the header list.',
  },
  {
    dependent: '@google-cloud/opentelemetry-cloud-monitoring-exporter',
    declaredRange: '^9.0.0',
    required: true,
    reason:
      'Passes its AuthClient to googleapis-common, which is written against the v9 client contract.',
  },
  {
    dependent: '@google-cloud/opentelemetry-cloud-trace-exporter',
    declaredRange: '^9.0.0',
    required: true,
    reason:
      '@grpc/grpc-js reads getRequestHeaders() as a plain object, so a v10 Headers result silently drops the Authorization header.',
  },
  {
    dependent: 'googleapis',
    declaredRange: '^9.0.0',
    required: true,
    reason:
      'Reachable only through the monitoring exporter, and the releases that declare v10 pull a googleapis-common that pins its own copy.',
  },
  {
    dependent: 'googleapis-common',
    declaredRange: '^9.7.0',
    required: true,
    reason:
      'Constructs DefaultTransporter, the only top-level export v10 removed.',
  },
  {
    // Removed by a separate dependent-scoped override. Marked optional so this
    // suite passes whichever of the two changes lands first.
    dependent: '@google-cloud/vertexai',
    declaredRange: '^9.1.0',
    required: false,
    reason: 'Deduplicated by a dependent-scoped override in a separate change.',
  },
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** The `packages` map of a parsed lockfile; empty for a malformed one. */
function lockPackages(lock: unknown): Readonly<Record<string, unknown>> {
  return isRecord(lock) && isRecord(lock.packages) ? lock.packages : {};
}

function entryVersion(entry: unknown): string | undefined {
  return isRecord(entry) && typeof entry.version === 'string'
    ? entry.version
    : undefined;
}

/** The nested (non-hoisted) `google-auth-library` copies, keyed by lock path. */
function nestedCopies(lock: unknown): ReadonlyMap<string, string> {
  const copies = new Map<string, string>();
  for (const [lockPath, entry] of Object.entries(lockPackages(lock))) {
    const version = entryVersion(entry);
    if (version !== undefined && lockPath.endsWith(NESTED_SUFFIX)) {
      copies.set(lockPath, version);
    }
  }
  return copies;
}

function hoistedVersion(lock: unknown): string | undefined {
  return entryVersion(lockPackages(lock)[HOISTED_PATH]);
}

/** The range `dependent` declares for `google-auth-library`, per the lockfile. */
function declaredRange(lock: unknown, dependent: string): string | undefined {
  const entry = lockPackages(lock)[`node_modules/${dependent}`];
  if (!isRecord(entry) || !isRecord(entry.dependencies)) {
    return undefined;
  }
  const range = entry.dependencies[PKG];
  return typeof range === 'string' ? range : undefined;
}

function lockPathFor(dependent: string): string {
  return `node_modules/${dependent}${NESTED_SUFFIX}`;
}

const lockfile: unknown = JSON.parse(
  readFileSync(resolve(process.cwd(), LOCKFILE), 'utf8'),
);

describe(`${PKG} duplication`, () => {
  it('resolves the hoisted copy on the v10 line', () => {
    const version = hoistedVersion(lockfile);
    if (version === undefined) {
      expect.fail(`${HOISTED_PATH} is missing from ${LOCKFILE}.`);
    }
    expect(version.split('.')[0]).toBe('10');
  });

  it('documents every nested copy', () => {
    const documented = new Set(
      ALLOWED_DUPLICATES.map((row) => lockPathFor(row.dependent)),
    );
    const undocumented = [...nestedCopies(lockfile).keys()].filter(
      (lockPath) => !documented.has(lockPath),
    );
    expect(
      undocumented,
      `Undocumented nested ${PKG} copies in ${LOCKFILE}: ${undocumented.join(', ')}. ` +
        `Work through the re-check protocol in ${DOC} before adding a row to ALLOWED_DUPLICATES.`,
    ).toEqual([]);
  });

  it('retires documented copies once upstream drops them', () => {
    const present = nestedCopies(lockfile);
    const retired = ALLOWED_DUPLICATES.filter(
      (row) => row.required && !present.has(lockPathFor(row.dependent)),
    );
    expect(
      retired.map((row) => row.dependent),
      `These dependents no longer nest their own ${PKG} and have probably adopted v10: ` +
        `${retired.map((row) => `${row.dependent} (${row.reason})`).join('; ')}. ` +
        `Delete each row from ALLOWED_DUPLICATES and its section in ${DOC}.`,
    ).toEqual([]);
  });

  it.each(ALLOWED_DUPLICATES)(
    'records the range $dependent declares',
    ({dependent, declaredRange: expected}) => {
      expect(
        declaredRange(lockfile, dependent),
        `${dependent} no longer declares ${PKG} ${expected}. Re-run the protocol in ${DOC} and update the row.`,
      ).toBe(expected);
    },
  );

  describe('lockfile helpers', () => {
    it('reports a nested copy', () => {
      const lock = {
        packages: {
          [HOISTED_PATH]: {version: '10.7.0'},
          [lockPathFor('does-not-exist')]: {version: '9.15.1'},
        },
      };
      expect([...nestedCopies(lock)]).toEqual([
        [lockPathFor('does-not-exist'), '9.15.1'],
      ]);
    });

    it('ignores the hoisted copy', () => {
      const lock = {packages: {[HOISTED_PATH]: {version: '10.7.0'}}};
      expect(nestedCopies(lock).size).toBe(0);
      expect(hoistedVersion(lock)).toBe('10.7.0');
    });

    it.each([
      {label: 'a non-object lockfile', lock: 'not-a-lockfile'},
      {label: 'a null lockfile', lock: null},
      {label: 'no packages key', lock: {}},
      {label: 'a non-object packages value', lock: {packages: null}},
      {label: 'a non-object package entry', lock: {packages: {a: null}}},
      {
        label: 'an entry without a string version',
        lock: {packages: {[HOISTED_PATH]: {version: 10}}},
      },
    ])('yields nothing for $label', ({lock}) => {
      expect(hoistedVersion(lock)).toBeUndefined();
      expect(nestedCopies(lock).size).toBe(0);
      expect(declaredRange(lock, '@google-cloud/storage')).toBeUndefined();
    });

    it.each([
      {
        label: 'the dependent is absent',
        lock: {packages: {}},
      },
      {
        label: 'the dependent declares no dependencies',
        lock: {packages: {'node_modules/dep': {version: '1.0.0'}}},
      },
      {
        label: 'the declared range is not a string',
        lock: {packages: {'node_modules/dep': {dependencies: {[PKG]: 9}}}},
      },
    ])('reports no declared range when $label', ({lock}) => {
      expect(declaredRange(lock, 'dep')).toBeUndefined();
    });

    it('reads the declared range of a dependent', () => {
      const lock = {
        packages: {'node_modules/dep': {dependencies: {[PKG]: '^9.0.0'}}},
      };
      expect(declaredRange(lock, 'dep')).toBe('^9.0.0');
    });
  });
});
