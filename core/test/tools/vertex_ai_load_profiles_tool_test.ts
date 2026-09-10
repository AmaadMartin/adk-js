/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

// Ported from adk-python
// tests/unittests/tools/test_vertex_ai_load_profiles_tool.py
// at main (a119dd7751082dbbd9a65f71e359abdc2be659cc).

import {MemoryProfile} from '@google-cloud/vertexai/build/src/genai/types.js';
import {
  Context,
  createSession,
  InvocationContext,
  LlmRequest,
  PluginManager,
  VertexAiLoadProfilesTool,
  VertexAiMemoryBankService,
} from '@google/adk';
import {Type} from '@google/genai';
import {describe, expect, it, vi} from 'vitest';

// The service builds a `Client` from the package root when no client is
// passed. The tool never reaches the SDK, so an inert client is enough.
vi.mock('@google-cloud/vertexai', () => ({
  Client: class {
    readonly agentEnginesInternal = {memories: {}};
  },
}));

function createMemoryService(profiles: MemoryProfile[]) {
  const service = new VertexAiMemoryBankService({agentEngineId: 'test-engine'});
  const retrieveProfiles = vi
    .spyOn(service, 'retrieveProfiles')
    .mockResolvedValue(profiles);
  return {service, retrieveProfiles};
}

function createToolContext(): Context {
  return new Context({
    invocationContext: new InvocationContext({
      invocationId: 'test-invocation',
      session: createSession({
        id: 'test-session',
        appName: 'test-app',
        userId: 'test-user',
      }),
      pluginManager: new PluginManager([]),
    }),
  });
}

function createLlmRequest(): LlmRequest {
  return {contents: [], toolsDict: {}, liveConnectConfig: {}};
}

describe('VertexAiLoadProfilesTool ported from adk-python', () => {
  it('test_load_profiles_returns_profile_payloads', async () => {
    const {service, retrieveProfiles} = createMemoryService([
      {schemaId: 'user-profile', profile: {name: 'Kim'}},
      {schemaId: 'empty', profile: {}},
    ]);
    const tool = new VertexAiLoadProfilesTool(service);

    const result = await tool.runAsync({
      args: {},
      toolContext: createToolContext(),
    });

    expect(result).toEqual({profiles: [{name: 'Kim'}]});
    expect(retrieveProfiles.mock.calls).toEqual([
      [{appName: 'test-app', userId: 'test-user'}],
    ]);
  });

  // adk-js decides the JSON-schema declaration shape centrally, so this tool
  // has no feature flag of its own to toggle. The Python test's enabled-flag
  // counterpart has no equivalent here.
  it('test_get_declaration_with_json_schema_feature_disabled', () => {
    const {service} = createMemoryService([]);
    const tool = new VertexAiLoadProfilesTool(service);

    const declaration = tool._getDeclaration();

    expect(declaration.name).toBe('load_profiles');
    expect(declaration.description).toBe(
      'Loads structured user profiles for the current user.',
    );
    expect(declaration.parametersJsonSchema).toBeUndefined();
    expect(declaration.parameters).toEqual({
      type: Type.OBJECT,
      properties: {},
    });
  });

  it('test_process_llm_request_registers_tool_only', async () => {
    const {service} = createMemoryService([]);
    const tool = new VertexAiLoadProfilesTool(service);
    const llmRequest = createLlmRequest();

    await tool.processLlmRequest({
      toolContext: createToolContext(),
      llmRequest,
    });

    expect(llmRequest.config?.systemInstruction).toBeUndefined();
    const [declaredTool] = llmRequest.config?.tools ?? [];
    if (!declaredTool || !('functionDeclarations' in declaredTool)) {
      expect.fail('expected a tool carrying function declarations');
    }
    expect(declaredTool.functionDeclarations?.[0].name).toBe('load_profiles');
    expect(llmRequest.toolsDict['load_profiles']).toBe(tool);
  });
});

describe('VertexAiLoadProfilesTool adk-js specific', () => {
  it('returns no profiles when the service has none', async () => {
    const {service} = createMemoryService([]);
    const tool = new VertexAiLoadProfilesTool(service);

    const result = await tool.runAsync({
      args: {},
      toolContext: createToolContext(),
    });

    expect(result).toEqual({profiles: []});
  });

  it('drops a profile that carries no payload', async () => {
    const {service} = createMemoryService([
      {schemaId: 'absent'},
      {schemaId: 'user-profile', profile: {name: 'Kim'}},
    ]);
    const tool = new VertexAiLoadProfilesTool(service);

    const result = await tool.runAsync({
      args: {},
      toolContext: createToolContext(),
    });

    expect(result).toEqual({profiles: [{name: 'Kim'}]});
  });

  it('keeps the order the service returned', async () => {
    const {service} = createMemoryService([
      {schemaId: 'first', profile: {order: 1}},
      {schemaId: 'second', profile: {order: 2}},
    ]);
    const tool = new VertexAiLoadProfilesTool(service);

    const result = await tool.runAsync({
      args: {},
      toolContext: createToolContext(),
    });

    expect(result).toEqual({profiles: [{order: 1}, {order: 2}]});
  });

  it('propagates a failure from the memory service', async () => {
    const {service, retrieveProfiles} = createMemoryService([]);
    retrieveProfiles.mockRejectedValue(new Error('memory bank unavailable'));
    const tool = new VertexAiLoadProfilesTool(service);

    await expect(
      tool.runAsync({args: {}, toolContext: createToolContext()}),
    ).rejects.toThrow('memory bank unavailable');
  });
});
