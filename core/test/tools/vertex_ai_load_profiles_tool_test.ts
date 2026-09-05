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
  ProfileRetrievingMemoryService,
  RunAsyncToolRequest,
  VertexAiLoadProfilesTool,
} from '@google/adk';
import {Type} from '@google/genai';
import {describe, expect, it} from 'vitest';

class FakeMemoryService implements ProfileRetrievingMemoryService {
  readonly calls: Array<[string, string]> = [];

  constructor(private readonly profiles: MemoryProfile[]) {}

  async retrieveProfiles(request: {
    appName: string;
    userId: string;
  }): Promise<MemoryProfile[]> {
    this.calls.push([request.appName, request.userId]);
    return this.profiles;
  }
}

class RejectingMemoryService implements ProfileRetrievingMemoryService {
  async retrieveProfiles(): Promise<MemoryProfile[]> {
    throw new Error('memory bank unavailable');
  }
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
    const memoryService = new FakeMemoryService([
      {schemaId: 'user-profile', profile: {name: 'Kim'}},
      {schemaId: 'empty', profile: {}},
    ]);
    const tool = new VertexAiLoadProfilesTool({memoryService});

    const result = await tool.runAsync({
      args: {},
      toolContext: createToolContext(),
    });

    expect(result).toEqual({profiles: [{name: 'Kim'}]});
    expect(memoryService.calls).toEqual([['test-app', 'test-user']]);
  });

  // adk-js decides the declaration shape centrally, in
  // `FunctionTool._getDeclaration`, so this tool has no feature flag of its own
  // to toggle. The Python test's enabled-flag counterpart has no equivalent
  // here.
  it('test_get_declaration_with_json_schema_feature_disabled', () => {
    const tool = new VertexAiLoadProfilesTool({
      memoryService: new FakeMemoryService([]),
    });

    const declaration = tool._getDeclaration();

    expect(declaration.name).toBe('load_profiles');
    expect(declaration.parametersJsonSchema).toBeUndefined();
    expect(declaration.parameters).toEqual({
      type: Type.OBJECT,
      properties: {},
    });
  });

  it('test_process_llm_request_registers_tool_only', async () => {
    const tool = new VertexAiLoadProfilesTool({
      memoryService: new FakeMemoryService([]),
    });
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
    const tool = new VertexAiLoadProfilesTool({
      memoryService: new FakeMemoryService([]),
    });

    const result = await tool.runAsync({
      args: {},
      toolContext: createToolContext(),
    });

    expect(result).toEqual({profiles: []});
  });

  it('drops a profile that carries no payload', async () => {
    const tool = new VertexAiLoadProfilesTool({
      memoryService: new FakeMemoryService([
        {schemaId: 'absent'},
        {schemaId: 'user-profile', profile: {name: 'Kim'}},
      ]),
    });

    const result = await tool.runAsync({
      args: {},
      toolContext: createToolContext(),
    });

    expect(result).toEqual({profiles: [{name: 'Kim'}]});
  });

  it('keeps the order the service returned', async () => {
    const tool = new VertexAiLoadProfilesTool({
      memoryService: new FakeMemoryService([
        {schemaId: 'first', profile: {order: 1}},
        {schemaId: 'second', profile: {order: 2}},
      ]),
    });

    const result = await tool.runAsync({
      args: {},
      toolContext: createToolContext(),
    });

    expect(result).toEqual({profiles: [{order: 1}, {order: 2}]});
  });

  it('reports a missing tool context as a failed tool call', async () => {
    const tool = new VertexAiLoadProfilesTool({
      memoryService: new FakeMemoryService([]),
    });
    // `RunAsyncToolRequest.toolContext` is required, so a typed caller cannot
    // omit it. This cast reproduces the untyped caller the guard exists for.
    const request = {args: {}} as unknown as RunAsyncToolRequest;

    await expect(tool.runAsync(request)).rejects.toThrow(
      "Error in tool 'load_profiles': Tool 'load_profiles' requires a tool context.",
    );
  });

  it('reports a failing service as a failed tool call', async () => {
    const tool = new VertexAiLoadProfilesTool({
      memoryService: new RejectingMemoryService(),
    });

    await expect(
      tool.runAsync({args: {}, toolContext: createToolContext()}),
    ).rejects.toThrow("Error in tool 'load_profiles': memory bank unavailable");
  });
});
