/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * A module that binds an agent but is named neither `agent` nor exposes an
 * `agent` namespace, so `resolveAgentForEval` rejects its specifier.
 */

import {LlmAgent} from '@google/adk';

/** The agent the loader never reaches, because the module name is wrong. */
export const rootAgent = new LlmAgent({name: 'unreachable_agent'});
