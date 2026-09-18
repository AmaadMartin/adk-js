/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {App, LlmAgent} from '@google/adk';

import {ScriptedLlm} from '../test_helpers.js';

const rootAgent = new LlmAgent({
  name: 'app_root_agent',
  model: new ScriptedLlm(['from the app root agent']),
});

export const agent = {
  app: new App({name: 'fixture_app', rootAgent}),
};
