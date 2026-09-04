/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Command-line entry point for the v0 to v1 sessions migration.
 *
 * Running this module runs the migration, so it needs no entry-point guard and
 * stays loadable under both the ESM and the CommonJS build:
 *
 * ```bash
 * node node_modules/@google/adk/dist/esm/sessions/migration/cli.js \
 *   --source_db_url "sqlite:///./legacy.db" \
 *   --dest_db_url   "sqlite:///./migrated.db"
 * ```
 */

import process from 'node:process';
import {main} from './migrate_from_sqlalchemy_pickle.js';

main(process.argv.slice(2)).then((exitCode) => {
  process.exitCode = exitCode;
});
