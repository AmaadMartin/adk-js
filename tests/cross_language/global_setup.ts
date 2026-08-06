/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {buildGoFixture, GO_FIXTURES} from './a2a/go_fixtures.js';

/**
 * Compiles the Go fixtures once per `vitest --project cross-language` run, so
 * no test or hook pays the compile. The fixtures share most of their
 * dependency graph, so building them in order lets the second reuse the
 * `GOCACHE` entries the first produced.
 */
export function setup(): void {
  for (const fixture of GO_FIXTURES) {
    buildGoFixture(fixture);
  }
}
