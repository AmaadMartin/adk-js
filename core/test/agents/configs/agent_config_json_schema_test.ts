/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import {fileURLToPath} from 'node:url';
import {beforeAll, describe, expect, it} from 'vitest';

import {
  AGENT_CONFIG_SCHEMA_FILENAME,
  AGENT_CONFIG_SCHEMA_SCRIPT,
  buildAgentConfigJsonSchema,
} from '../../../src/agents/configs/agent_config_json_schema.js';

const ARTEFACT_PATH = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  'src',
  'agents',
  'configs',
  AGENT_CONFIG_SCHEMA_FILENAME,
);

/** Every `$defs` entry the artefact is expected to carry. */
const EXPECTED_DEFS = [
  'LlmAgentConfig',
  'LoopAgentConfig',
  'ParallelAgentConfig',
  'SequentialAgentConfig',
  'BaseAgentConfig',
  'AgentRefConfig',
  'CodeConfig',
  'ToolConfig',
];

interface JsonSchemaObject {
  title?: string;
  $schema?: string;
  anyOf?: Array<{$ref?: string}>;
  $defs?: Record<string, {properties?: Record<string, unknown>}>;
}

describe('AgentConfig.json', () => {
  let contents: string;
  let parsed: JsonSchemaObject;

  beforeAll(async () => {
    contents = await fs.readFile(ARTEFACT_PATH, 'utf-8');
    parsed = JSON.parse(contents) as JsonSchemaObject;
  });

  it('matches what the Zod schemas produce', () => {
    expect(
      contents,
      `The checked-in ${AGENT_CONFIG_SCHEMA_FILENAME} is stale. Run \`${AGENT_CONFIG_SCHEMA_SCRIPT}\`.`,
    ).toBe(buildAgentConfigJsonSchema());
  });

  it('declares its JSON Schema dialect and title', () => {
    expect(parsed.$schema).toBe('https://json-schema.org/draft/2020-12/schema');
    expect(parsed.title).toBe('AgentConfig');
  });

  it('offers every agent config shape at the top level', () => {
    expect(parsed.anyOf?.map((branch) => branch.$ref)).toEqual([
      '#/$defs/LlmAgentConfig',
      '#/$defs/LoopAgentConfig',
      '#/$defs/ParallelAgentConfig',
      '#/$defs/SequentialAgentConfig',
      '#/$defs/BaseAgentConfig',
    ]);
  });

  it('defines every referenced shape', () => {
    expect(Object.keys(parsed.$defs ?? {}).sort()).toEqual(
      [...EXPECTED_DEFS].sort(),
    );
  });

  it('publishes the snake_case wire names, not their camelCase forms', () => {
    const properties = parsed.$defs?.['LlmAgentConfig']?.properties ?? {};
    expect(Object.keys(properties)).toEqual(
      expect.arrayContaining([
        'agent_class',
        'sub_agents',
        'output_key',
        'include_contents',
        'model_code',
        'before_agent_callbacks',
      ]),
    );
    expect(Object.keys(properties)).not.toEqual(
      expect.arrayContaining(['agentClass', 'subAgents', 'outputKey']),
    );
  });
});
