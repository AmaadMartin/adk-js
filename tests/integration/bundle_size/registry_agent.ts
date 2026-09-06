/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {App, LlmAgent} from '@google/adk';

const agent = new LlmAgent({name: 'registry_agent', model: 'gemini-2.5-flash'});

/**
 * Resolving the model at module scope proves `LLMRegistry` still has its
 * built-in registrations after the bundler tree-shakes the package. Exporting
 * the result keeps the minifier from eliding the getter call.
 */
export const canonicalModelName = agent.canonicalModel.model;

export const app = new App({name: 'registry_app', rootAgent: agent});
