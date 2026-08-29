/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  FeatureName,
  FunctionTool,
  LongRunningFunctionTool,
  overrideFeatureEnabled,
} from '@google/adk';
import {Schema, Type} from '@google/genai';
import {afterEach, describe, expect, it, vi} from 'vitest';
import {z} from 'zod/v3';
import {z as z4} from 'zod/v4';

/** A schema object the test can mutate, to observe whether a build re-reads it. */
function mutableSchema(): Schema {
  return {
    type: Type.OBJECT,
    properties: {query: {type: Type.STRING}},
    required: ['query'],
  };
}

function sampleTool(parameters?: Schema) {
  return new FunctionTool({
    name: 'sample_tool',
    description: 'Samples something.',
    parameters,
    execute: () => 'ok',
  });
}

describe('FunctionTool declaration caching', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    overrideFeatureEnabled(FeatureName.JSON_SCHEMA_FOR_FUNC_DECL, undefined);
  });

  it('serves a second call from the cache instead of rebuilding', () => {
    const parameters = mutableSchema();
    const tool = sampleTool(parameters);

    tool._getDeclaration();
    parameters.properties!['added_later'] = {type: Type.STRING};

    expect(tool._getDeclaration().parameters?.properties).not.toHaveProperty(
      'added_later',
    );
  });

  it('serves a second Vertex AI call from the cache', () => {
    vi.stubEnv('GOOGLE_GENAI_USE_ENTERPRISE', 'true');
    const parameters = mutableSchema();
    const tool = sampleTool(parameters);

    tool._getDeclaration();
    parameters.properties!['added_later'] = {type: Type.STRING};

    expect(tool._getDeclaration().parameters?.properties).not.toHaveProperty(
      'added_later',
    );
  });

  it('returns an independent copy on every call', () => {
    const tool = sampleTool(mutableSchema());

    const first = tool._getDeclaration();
    const second = tool._getDeclaration();
    expect(first).not.toBe(second);
    expect(first).toEqual(second);

    first.name = 'mutated';
    first.parameters!.properties!['query']!.description = 'mutated';

    const third = tool._getDeclaration();
    expect(third.name).toBe('sample_tool');
    expect(third.parameters?.properties?.['query']).toEqual({
      type: Type.STRING,
    });
  });

  it('does not accumulate the long-running instruction across calls', () => {
    const tool = new LongRunningFunctionTool({
      name: 'slow_tool',
      description: 'Takes a while.',
      execute: () => 'ok',
    });

    const descriptions = [
      tool._getDeclaration().description,
      tool._getDeclaration().description,
      tool._getDeclaration().description,
    ];

    expect(descriptions[1]).toBe(descriptions[0]);
    expect(descriptions[2]).toBe(descriptions[0]);
    expect(descriptions[0]).toContain('Takes a while.');
  });

  it('rebuilds when the API variant changes', () => {
    const tool = sampleTool({
      type: Type.OBJECT,
      properties: {email: {type: Type.STRING, format: 'email'}},
    });

    expect(
      tool._getDeclaration().parameters?.properties?.['email'],
    ).not.toHaveProperty('format');

    vi.stubEnv('GOOGLE_GENAI_USE_ENTERPRISE', 'true');

    expect(tool._getDeclaration().parameters?.properties?.['email']).toEqual({
      type: Type.STRING,
      format: 'email',
    });
  });

  it('rebuilds when the JSON schema feature flips', () => {
    const tool = sampleTool(mutableSchema());

    expect(tool._getDeclaration().parameters).toBeDefined();

    overrideFeatureEnabled(FeatureName.JSON_SCHEMA_FOR_FUNC_DECL, true);

    const declaration = tool._getDeclaration();
    expect(declaration.parameters).toBeUndefined();
    expect(declaration.parametersJsonSchema).toBeDefined();
  });
});

describe('FunctionTool declaration shape', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    overrideFeatureEnabled(FeatureName.JSON_SCHEMA_FOR_FUNC_DECL, undefined);
  });

  it('emits a raw JSON schema when the feature is on', () => {
    overrideFeatureEnabled(FeatureName.JSON_SCHEMA_FOR_FUNC_DECL, true);
    const tool = new FunctionTool({
      name: 'sample_tool',
      description: 'Samples something.',
      parameters: z.object({query: z.string()}),
      execute: () => 'ok',
    });

    const declaration = tool._getDeclaration();

    expect(declaration.parameters).toBeUndefined();
    expect(declaration.parametersJsonSchema).toMatchObject({
      type: 'object',
      properties: {query: {type: 'string'}},
    });
  });

  it('flattens a nullable field on Vertex AI when the feature is on', () => {
    vi.stubEnv('GOOGLE_GENAI_USE_ENTERPRISE', 'true');
    overrideFeatureEnabled(FeatureName.JSON_SCHEMA_FOR_FUNC_DECL, true);
    const tool = new FunctionTool({
      name: 'sample_tool',
      description: 'Samples something.',
      parameters: z4.object({note: z4.string().nullable()}),
      execute: () => 'ok',
    });

    expect(tool._getDeclaration().parametersJsonSchema).toMatchObject({
      properties: {note: {type: 'string', nullable: true}},
    });
  });

  it('keeps the nullable union on the Gemini Developer API', () => {
    overrideFeatureEnabled(FeatureName.JSON_SCHEMA_FOR_FUNC_DECL, true);
    const tool = new FunctionTool({
      name: 'sample_tool',
      description: 'Samples something.',
      parameters: z4.object({note: z4.string().nullable()}),
      execute: () => 'ok',
    });

    expect(tool._getDeclaration().parametersJsonSchema).toMatchObject({
      properties: {note: {anyOf: [{type: 'string'}, {type: 'null'}]}},
    });
  });

  it('declares an empty object for a tool with no parameters', () => {
    const tool = new FunctionTool({name: 'sample_tool', execute: () => 'ok'});

    expect(tool._getDeclaration().parameters).toEqual({
      type: Type.OBJECT,
      properties: {},
    });

    overrideFeatureEnabled(FeatureName.JSON_SCHEMA_FOR_FUNC_DECL, true);
    expect(tool._getDeclaration().parametersJsonSchema).toEqual({
      type: 'object',
      properties: {},
    });
  });

  it('strips a format the Gemini Developer API rejects', () => {
    const tool = sampleTool({
      type: Type.OBJECT,
      properties: {
        email: {type: Type.STRING, format: 'email'},
        created: {type: Type.STRING, format: 'date-time'},
      },
    });

    expect(tool._getDeclaration().parameters?.properties).toEqual({
      email: {type: Type.STRING},
      created: {type: Type.STRING, format: 'date-time'},
    });
  });

  it('keeps every format on Vertex AI', () => {
    vi.stubEnv('GOOGLE_GENAI_USE_ENTERPRISE', 'true');
    const tool = sampleTool({
      type: Type.OBJECT,
      properties: {email: {type: Type.STRING, format: 'email'}},
    });

    expect(tool._getDeclaration().parameters?.properties).toEqual({
      email: {type: Type.STRING, format: 'email'},
    });
  });

  it('defaults the description to an empty string when it is omitted', () => {
    const tool = new FunctionTool({name: 'sample_tool', execute: () => 'ok'});

    expect(tool.description).toBe('');
    expect(tool._getDeclaration().description).toBe('');
  });

  it('advertises the execute function name when no name is given', () => {
    const tool = new FunctionTool({
      description: 'Samples something.',
      execute: function sample_tool() {
        return 'ok';
      },
    });

    expect(tool.name).toBe('sample_tool');
    expect(tool._getDeclaration().name).toBe('sample_tool');
  });

  it('falls back to the property name for an inline arrow function', () => {
    const tool = new FunctionTool({execute: () => 'ok'});

    expect(tool._getDeclaration().name).toBe('execute');
  });

  it('refuses a name that resolves to nothing', () => {
    expect(() => new FunctionTool({name: '', execute: () => 'ok'})).toThrow(
      'Tool name cannot be empty',
    );
  });

  it('keeps a supplied description', () => {
    expect(sampleTool().description).toBe('Samples something.');
    expect(sampleTool()._getDeclaration().description).toBe(
      'Samples something.',
    );
  });
});
