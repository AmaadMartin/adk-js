/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {InMemorySessionService} from '@google/adk';

/**
 * A stand-in for a real backend. It keeps sessions in memory and remembers the
 * URI it was built from, which is all a demo needs to show the registry works.
 */
export class DemoSessionService extends InMemorySessionService {
  constructor({uri}) {
    super();
    this.uri = uri;
  }
}
