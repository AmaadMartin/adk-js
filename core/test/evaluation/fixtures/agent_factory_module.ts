/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/** An agent module that builds its agent asynchronously. */

import {BaseAgent, LlmAgent} from '@google/adk';

export async function getAgentAsync(): Promise<[BaseAgent, object]> {
  return [
    new LlmAgent({name: 'factory_agent', model: 'gemini-2.5-flash'}),
    {cleanup: 'none'},
  ];
}
