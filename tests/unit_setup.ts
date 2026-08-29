/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {scrubEnv} from './env_scrub.js';

/**
 * Environment scrub for the `unit:core`, `unit:dev` and `unit:integrations`
 * Vitest projects.
 *
 * A unit test must produce the same result on a developer machine and in CI, so
 * an exported `GOOGLE_CLOUD_PROJECT` must not reach the code under test. The
 * scrub runs at module scope, before Vitest imports the test file, because the
 * developer exported the variable long before a `beforeEach` would fire, and
 * because a test file may set its own value in `beforeAll`.
 *
 * The values are never restored. A worker process outlives the test file that
 * scrubbed them, and it exists only to run tests.
 *
 * The `integration`, `e2e` and `cross-language` projects do not load this file:
 * they need the real credentials in the ambient environment.
 */
scrubEnv(process.env);
