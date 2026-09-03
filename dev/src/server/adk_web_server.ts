/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Backward-compatible surface of the former `AdkWebServer` module.
 *
 * The class moved to `adk_api_server.ts` and was renamed `AdkApiServer`. This
 * module keeps the old name and the symbols that used to be reachable through
 * it, mirroring adk-python's `cli/adk_web_server.py` shim.
 */

import {deprecated} from '@google/adk';

import {AdkApiServer} from './adk_api_server.js';

export {AgentLoader} from '../utils/agent_loader.js';
export type {RunAgentRequest} from './adk_api_client.js';
export {parseCorsOrigins} from './cors_origins.js';
export type {ParsedCorsOrigins} from './cors_origins.js';

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
