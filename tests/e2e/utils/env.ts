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

// Resolution order, anchored to this module so a caller's nesting depth cannot
// change it: tests/e2e/.env (a copy of .env.template) first, then a repo-root
// .env. Only the first hit is read — merging two independently written files is
// the half-configured state this exists to rule out. Values already in
// process.env win; no .env at all is the normal CI state, not an error.
const CANDIDATE_PATHS = [
  path.resolve(UTILS_DIR, '..', '.env'),
  path.resolve(UTILS_DIR, '..', '..', '..', '.env'),
];

/** Loads the e2e `.env` into `process.env`. */
export function loadE2eEnv(): void {
  for (const candidate of CANDIDATE_PATHS) {
    if (fs.existsSync(candidate)) {
      dotenv.config({path: candidate});
      return;
    }
  }
}
