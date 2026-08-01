/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as dotenv from 'dotenv';
import {fileURLToPath} from 'node:url';

// Runs once per e2e test file, via `setupFiles` in vitest.config.ts.
//
// `tests/e2e/.env` -- the sibling of the committed .env.template -- is the one
// location the suite reads, anchored to this module so neither a caller's
// nesting depth nor the process working directory can move it. Values already
// in process.env win, so `override` is deliberately unset. A missing file is
// the normal CI state rather than an error: dotenv reports it in the return
// value instead of throwing, which leaves each suite's own credential guard as
// the single place that decides whether it runs.
dotenv.config({
  path: fileURLToPath(new URL('../.env', import.meta.url)),
  quiet: true,
});
