/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  FeatureName,
  MCPSessionManager,
  MCPTool,
  withTemporaryFeatureOverride,
} from '@google/adk';
import {Tool} from '@modelcontextprotocol/sdk/types.js';
import {describe, expect, it} from 'vitest';

const INPUT_SCHEMA = {
  type: 'object' as const,
  properties: {city: {type: 'string'}},
  required: ['city'],
};

const OUTPUT_SCHEMA = {
  type: 'object' as const,
  properties: {temperature: {type: 'number'}},
};

const sessionManager = new MCPSessionManager({
  type: 'StreamableHTTPConnectionParams',
  url: 'http://localhost/unused',
});

function weatherTool(outputSchema?: Tool['outputSchema']): Tool {
  return {
    name: 'weather',
    description: 'Reports the weather.',
    inputSchema: INPUT_SCHEMA,
    outputSchema,
  };
}

/** Runs `body` with the raw JSON Schema declaration turned on. */
function withJsonSchema<T>(body: () => T): Promise<T> {
  return withTemporaryFeatureOverride(
    FeatureName.JSON_SCHEMA_FOR_FUNC_DECL,
    true,
    body,
  );
}

describe('MCPTool._getDeclaration with JSON_SCHEMA_FOR_FUNC_DECL on', () => {
  it('declares the server schema untouched instead of a genai Schema', async () => {
    const tool = new MCPTool(weatherTool(OUTPUT_SCHEMA), sessionManager);

    const declaration = await withJsonSchema(() => tool._getDeclaration());

    expect(declaration.parametersJsonSchema).toBe(INPUT_SCHEMA);
    expect(declaration.responseJsonSchema).toBe(OUTPUT_SCHEMA);
  });

  it('declares no genai Schema alongside the raw JSON Schema', async () => {
    const tool = new MCPTool(weatherTool(OUTPUT_SCHEMA), sessionManager);

    const declaration = await withJsonSchema(() => tool._getDeclaration());

    expect(declaration.parameters).toBeUndefined();
    expect(declaration.response).toBeUndefined();
  });

  it('declares no response schema for a tool that publishes none', async () => {
    const tool = new MCPTool(weatherTool(), sessionManager);

    const declaration = await withJsonSchema(() => tool._getDeclaration());

    expect(declaration.responseJsonSchema).toBeUndefined();
    expect(declaration.parametersJsonSchema).toBe(INPUT_SCHEMA);
  });

  it('keeps the name and description', async () => {
    const tool = new MCPTool(weatherTool(), sessionManager);

    const declaration = await withJsonSchema(() => tool._getDeclaration());

    expect(declaration.name).toBe('weather');
    expect(declaration.description).toBe('Reports the weather.');
  });
});

describe('MCPTool._getDeclaration with JSON_SCHEMA_FOR_FUNC_DECL off', () => {
  it('declares a genai Schema, as it did before the feature existed', () => {
    const tool = new MCPTool(weatherTool(OUTPUT_SCHEMA), sessionManager);

    const declaration = tool._getDeclaration();

    expect(declaration.parameters).toEqual({
      type: 'OBJECT',
      properties: {city: {type: 'STRING'}},
      required: ['city'],
    });
    expect(declaration.response).toEqual({
      type: 'OBJECT',
      properties: {temperature: {type: 'NUMBER'}},
    });
  });

  it('declares no raw JSON Schema', () => {
    const tool = new MCPTool(weatherTool(OUTPUT_SCHEMA), sessionManager);

    const declaration = tool._getDeclaration();

    expect(declaration.parametersJsonSchema).toBeUndefined();
    expect(declaration.responseJsonSchema).toBeUndefined();
  });
});
