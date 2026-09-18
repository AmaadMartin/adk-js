/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {InMemorySessionService} from '@google/adk';
import * as fs from 'node:fs';

/**
 * An in-process stand-in for a custom backend, so the test needs no network.
 *
 * The URI names a file, and building the service writes the URI into it. That
 * is how the test sees which service the CLI built, across the process the
 * services file is compiled and imported in.
 */
export class FakeSessionService extends InMemorySessionService {
  constructor(uri: string) {
    super();
    fs.writeFileSync(uri.replace('fake://', ''), uri, {encoding: 'utf-8'});
  }
}
