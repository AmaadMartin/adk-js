/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * An agent module in the layout `resolveAgentForEval` expects from a specifier:
 * a module named `agent` that binds `rootAgent` and the app wrapping it.
 */

import {App, LlmAgent} from '@google/adk';

/** The agent a specifier-based test resolves. */
export const rootAgent = new LlmAgent({name: 'fixture_root_agent'});

/** The app the loader surfaces alongside the agent. */
export const app = new App({name: 'fixture_app', rootAgent});
