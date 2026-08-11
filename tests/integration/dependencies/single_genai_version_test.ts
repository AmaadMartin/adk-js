/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {readFileSync} from 'node:fs';
import {expect, it} from 'vitest';

/** Lockfile key of the single, hoisted `@google/genai` install. */
const HOISTED_GENAI = 'node_modules/@google/genai';

interface PackageLock {
  packages: Record<string, unknown>;
}

/** Lockfile keys of every physical `@google/genai` install. */
function installedGenaiCopies(): string[] {
  const lock: PackageLock = JSON.parse(
    readFileSync(
      new URL('../../../package-lock.json', import.meta.url),
      'utf8',
    ),
  );
  return Object.keys(lock.packages)
    .filter((key) => key === HOISTED_GENAI || key.endsWith(`/${HOISTED_GENAI}`))
    .sort();
}

// `core` declares @google/genai ^2.9.0 while @google-cloud/vertexai pins
// ^1.45.0, so without the root `overrides` block npm installs both majors and
// nests the second copy. Two copies then load into one process and the
// `Sessions` constructor ends up typed against an `ApiClient` the rest of the
// repo cannot produce.
//
// The lockfile is the artifact to assert on: resolving `@google/genai` from
// core/src, dev/src or tests/ finds one copy even while a copy nested under
// @google-cloud/vertexai survives, because none of those directories resolve
// through vertexai.
it('installs exactly one copy of @google/genai, hoisted to the root', () => {
  expect(installedGenaiCopies()).toEqual([HOISTED_GENAI]);
});
