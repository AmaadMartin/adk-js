/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {InMemorySessionService} from '@google/adk';

/**
 * A session backend registered from `services.yaml`.
 *
 * It keeps sessions in memory and stamps the URI that selected it into every
 * session's state, so a run shows which backend served it. A real backend
 * would open a connection here instead.
 *
 * The file is plain JavaScript because the registry imports it at run time,
 * and Node imports JavaScript only.
 */
export class DemoSessionService extends InMemorySessionService {
  constructor({uri}) {
    super();
    this.uri = uri;
  }

  async createSession(request) {
    return super.createSession({
      ...request,
      state: {...request.state, sessionBackend: this.uri},
    });
  }
}
