/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as dotenv from 'dotenv';
import {fileURLToPath} from 'node:url';

// The one location the e2e suites read credentials from: the sibling of the
// committed .env.template. Anchored to this module, so neither a caller's
// nesting depth nor the process working directory can change it.
const E2E_ENV_PATH = fileURLToPath(new URL('../.env', import.meta.url));

/**
 * Loads `tests/e2e/.env` into `process.env`.
 *
 * Values already in `process.env` win: a shell-exported credential is not
 * overwritten by the file, so `override` is deliberately left unset. A missing
 * file is the normal CI state rather than an error — dotenv reports it in the
 * return value instead of throwing — which leaves each suite's own credential
 * guard as the single place that decides whether it runs.
 */
export function loadE2eEnv(): void {
  dotenv.config({path: E2E_ENV_PATH, quiet: true});
}
