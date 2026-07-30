/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import {LlmAgent} from '@google/adk';

export const rootAgent = new LlmAgent({
  name: 'deploy_fixture_agent',
  model: 'gemini-2.5-flash',
  description: 'Fixture agent for the Cloud Run deploy integration test.',
  instruction:
    'You are a fixture agent. You only exist so the deploy pipeline has ' +
    'something to stage; you are never asked to answer anything.',
});
