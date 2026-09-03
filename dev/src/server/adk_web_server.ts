/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Backward-compatible name of the class that moved to `adk_api_server.ts` and
 * was renamed `AdkApiServer`. Mirrors adk-python's `cli/adk_web_server.py`
 * shim.
 */

import {deprecated} from '@google/adk';

import {AdkApiServer} from './adk_api_server.js';

/**
 * Deprecated alias of {@link AdkApiServer}, kept so code written before the
 * rename keeps running.
 *
 * @deprecated Renamed to {@link AdkApiServer}. Use `AdkApiServer` instead.
 */
@deprecated(
  'AdkWebServer is deprecated and has been renamed to AdkApiServer. Use' +
    ' AdkApiServer instead.',
)
export class AdkWebServer extends AdkApiServer {}
