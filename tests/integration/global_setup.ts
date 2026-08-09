/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  cleanFixture,
  FIXTURE_PROJECT_DIRS,
  installFixture,
} from './fixture_installs.js';

/**
 * Installs every integration fixture, one at a time.
 *
 * The installs are sequential on purpose. All fixtures resolve the same
 * transitive tree, so concurrent `npm` processes only fight over the registry
 * and the shared `~/.npm` cache lock. The first install warms that cache and
 * the rest read from it.
 */
export function setup(): void {
  for (const projectDir of FIXTURE_PROJECT_DIRS) {
    installFixture(projectDir);
  }
}

export async function teardown(): Promise<void> {
  for (const projectDir of FIXTURE_PROJECT_DIRS) {
    await cleanFixture(projectDir);
  }
}
