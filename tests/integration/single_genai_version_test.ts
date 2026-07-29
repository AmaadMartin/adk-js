/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import {readFileSync} from 'node:fs';
import path from 'node:path';
import {expect, it} from 'vitest';

/** Lockfile key of the single, hoisted `@google/genai` install. */
const HOISTED_GENAI = 'node_modules/@google/genai';

interface PackageLock {
  packages: Record<string, {version?: string}>;
}

/**
 * Lockfile keys of every physical `@google/genai` install, annotated with the
 * version so a failure names the offending copies rather than just counting
 * them.
 */
function installedGenaiCopies(): string[] {
  const lock: PackageLock = JSON.parse(
    readFileSync(path.join(process.cwd(), 'package-lock.json'), 'utf8'),
  );
  return Object.keys(lock.packages)
    .filter((key) => key === HOISTED_GENAI || key.endsWith(`/${HOISTED_GENAI}`))
    .sort()
    .map((key) => `${key}@${lock.packages[key].version}`);
}

// core declares @google/genai ^2.9.0 while @google-cloud/vertexai pins
// ^1.45.0, so without the root `overrides` block npm installs both majors and
// nests the second copy. Two copies of the SDK then load into one process and
// instanceof / enum-identity checks that cross the boundary compare symbols
// from different modules.
//
// Asserting the lockfile rather than a resolution from any one directory is
// deliberate: which copy a file gets depends on where it sits in the tree, so
// a resolve() from core/src, dev/src, or tests/ still agrees while a copy
// nested under @google-cloud/vertexai survives. The lockfile is also what
// `npm ci` reifies, so it is the artifact that decides what CI installs.
//
// Count and location are one assertion so the diff prints every copy it found:
// a bare length check reports "expected 2 to be 1" without naming the offender.
it('installs exactly one copy of @google/genai, hoisted to the root', () => {
  expect(installedGenaiCopies()).toEqual([
    expect.stringMatching(new RegExp(`^${HOISTED_GENAI}@`)),
  ]);
});
