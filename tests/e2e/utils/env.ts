/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as dotenv from 'dotenv';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {fileURLToPath} from 'node:url';

const UTILS_DIR = path.dirname(fileURLToPath(import.meta.url));

/**
 * Candidate `.env` locations in resolution order: the canonical
 * `tests/e2e/.env` (copy `tests/e2e/.env.template` there), then a repo-root
 * `.env` shared with other tooling.
 */
const CANDIDATE_PATHS: readonly string[] = [
  path.resolve(UTILS_DIR, '..', '.env'),
  path.resolve(UTILS_DIR, '..', '..', '..', '.env'),
];

/**
 * Loads the e2e `.env` into `process.env`.
 *
 * Resolution is anchored to this module rather than to the caller, so every
 * e2e file reads the same file no matter how deeply it is nested. Only the
 * first existing candidate is read: the two locations are written by different
 * tools, and merging a repo-root agent `.env` into a test `.env` is the kind of
 * half-configured environment this loader exists to rule out. Values already in
 * `process.env` win, and a missing `.env` is the normal CI state, not an error.
 */
export function loadE2eEnv(): void {
  for (const candidate of CANDIDATE_PATHS) {
    if (fs.existsSync(candidate)) {
      dotenv.config({path: candidate});
      return;
    }
  }
}
