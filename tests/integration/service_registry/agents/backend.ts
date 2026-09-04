/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {InMemorySessionService} from '@google/adk';

/** A session backend the registry builds for the `demo://` scheme. */
export class DemoSessionService extends InMemorySessionService {
  constructor(readonly uri: string) {
    super();
  }
}
