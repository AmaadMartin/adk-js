/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  FeatureName,
  MCPSessionManager,
  MCPTool,
  overrideFeatureEnabled,
} from '@google/adk';
import {Type} from '@google/genai';
import type {Tool} from '@modelcontextprotocol/sdk/types.js';
import {afterEach, describe, expect, it} from 'vitest';

const sessionManager = {} as unknown as MCPSessionManager;

/**
 * A tool whose input schema uses `oneOf`, which `toGeminiSchema` cannot
 * express. It is the difference between the two declaration forms.
 */
function toolWithSchemas(): Tool {
  return {
    name: 'weather',
    description: 'Reports the weather.',
    inputSchema: {
      type: 'object',
      properties: {
        location: {oneOf: [{type: 'string'}, {type: 'number'}]},
      },
      required: ['location'],
    },
    outputSchema: {
      type: 'object',
      properties: {summary: {type: 'string'}},
    },
  };
}

describe('MCPTool._getDeclaration', () => {
  afterEach(() => {
    overrideFeatureEnabled(FeatureName.JSON_SCHEMA_FOR_FUNC_DECL, undefined);
  });

  it('converts the schemas to genai Schema by default', () => {
    const declaration = new MCPTool(
      toolWithSchemas(),
      sessionManager,
    )._getDeclaration();

    expect(declaration.name).toBe('weather');
    expect(declaration.description).toBe('Reports the weather.');
    expect(declaration.parameters?.type).toBe(Type.OBJECT);
    expect(declaration.parameters?.required).toEqual(['location']);
    expect(declaration.response?.type).toBe(Type.OBJECT);
    expect(declaration.parametersJsonSchema).toBeUndefined();
    expect(declaration.responseJsonSchema).toBeUndefined();
  });

  it('sends the server schemas verbatim under JSON_SCHEMA_FOR_FUNC_DECL', () => {
    overrideFeatureEnabled(FeatureName.JSON_SCHEMA_FOR_FUNC_DECL, true);
    const mcpTool = toolWithSchemas();

    const declaration = new MCPTool(mcpTool, sessionManager)._getDeclaration();

    expect(declaration.parametersJsonSchema).toBe(mcpTool.inputSchema);
    expect(declaration.responseJsonSchema).toBe(mcpTool.outputSchema);
    expect(declaration.parameters).toBeUndefined();
    expect(declaration.response).toBeUndefined();
  });

  it('keeps the oneOf that the genai Schema conversion drops', () => {
    overrideFeatureEnabled(FeatureName.JSON_SCHEMA_FOR_FUNC_DECL, true);

    const declaration = new MCPTool(
      toolWithSchemas(),
      sessionManager,
    )._getDeclaration();

    expect(declaration.parametersJsonSchema).toMatchObject({
      properties: {location: {oneOf: [{type: 'string'}, {type: 'number'}]}},
    });
  });

  it('leaves responseJsonSchema unset when the server declares no output schema', () => {
    overrideFeatureEnabled(FeatureName.JSON_SCHEMA_FOR_FUNC_DECL, true);
    const mcpTool = toolWithSchemas();
    delete mcpTool.outputSchema;

    const declaration = new MCPTool(mcpTool, sessionManager)._getDeclaration();

    expect(declaration.responseJsonSchema).toBeUndefined();
    expect(declaration.parametersJsonSchema).toBe(mcpTool.inputSchema);
  });

  it('returns the converted form again once the feature is disabled', () => {
    overrideFeatureEnabled(FeatureName.JSON_SCHEMA_FOR_FUNC_DECL, false);

    const declaration = new MCPTool(
      toolWithSchemas(),
      sessionManager,
    )._getDeclaration();

    expect(declaration.parameters?.type).toBe(Type.OBJECT);
    expect(declaration.parametersJsonSchema).toBeUndefined();
  });
});
