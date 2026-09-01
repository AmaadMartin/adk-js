/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/** An agent module whose factory returns the agent without a tuple. */

import {BaseAgent, LlmAgent} from '@google/adk';

export async function getAgentAsync(): Promise<BaseAgent> {
  return new LlmAgent({name: 'bare_factory_agent', model: 'gemini-2.5-flash'});
}
