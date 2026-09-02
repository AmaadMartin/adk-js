/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Fixture module that `resolveFullyQualifiedName` imports by path, standing in
 * for the user code an agent config file names.
 */

import {BaseAgent, LlmAgent} from '@google/adk';

/** A real agent instance, resolved by name in the tests. */
export const searchAgent = new LlmAgent({
  name: 'search_agent',
  description: 'searches the catalogue',
  model: 'gemini-2.5-flash',
});

/**
 * A plain object carrying an agent's name but not its identity symbol. It
 * proves the check is a type guard rather than a shape check.
 */
export const notAnAgent = {name: 'search_agent', description: 'not an agent'};

/** An agent class rather than an instance, which is a reference mistake. */
export class AgentClass extends LlmAgent {}

/** A factory returning an agent, which is also a reference mistake. */
export function makeAgent(): BaseAgent {
  return searchAgent;
}

export default searchAgent;
