/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {toJSONSchema, z} from 'zod/v4';

import {AGENT_YAML_CONFIG_SCHEMAS} from './agent_config.js';

/**
 * Builds the JSON Schema describing an agent config document.
 *
 * The document is what an editor validates a `root_agent.yaml` against, so it
 * describes the config as written: `io: 'input'` keeps a field with a default
 * optional rather than required.
 *
 * @returns The schema, serialised with a trailing newline.
 */
export function buildAgentConfigJsonSchema(): string {
  const schema = toJSONSchema(
    z.union(Object.values(AGENT_YAML_CONFIG_SCHEMAS)),
    {io: 'input', unrepresentable: 'any'},
  );
  return `${JSON.stringify({title: 'AgentConfig', ...schema}, null, 2)}\n`;
}
