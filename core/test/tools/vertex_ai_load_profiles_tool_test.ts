/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  Context,
  createSession,
  InvocationContext,
  LlmAgent,
  LlmRequest,
  PluginManager,
  VertexAiLoadProfilesTool,
  VertexAiMemoryBankService,
} from '@google/adk';
import {Type} from '@google/genai';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

// The service imports Client from the package root, so the mock must target it.
vi.mock('@google-cloud/vertexai', () => ({
  Client: class {
    readonly agentEnginesInternal = {memories: {}};
  },
}));

function createToolContext(appName: string, userId: string): Context {
  const invocationContext = new InvocationContext({
    invocationId: 'test-invocation',
    agent: new LlmAgent({name: 'test-agent', model: 'gemini-2.5-flash'}),
    session: createSession({id: 'test-session', appName, userId}),
    pluginManager: new PluginManager([]),
  });
  return new Context({invocationContext});
}

describe('VertexAiLoadProfilesTool', () => {
  let service: VertexAiMemoryBankService;
  let tool: VertexAiLoadProfilesTool;

  beforeEach(() => {
    vi.stubEnv('GOOGLE_GENAI_USE_VERTEXAI', 'false');
    service = new VertexAiMemoryBankService({agentEngineId: 'test-engine-id'});
    tool = new VertexAiLoadProfilesTool(service);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('computes the correct declaration', () => {
    const declaration = tool._getDeclaration();

    expect(declaration.name).toEqual('load_profiles');
    expect(declaration.description).toEqual(
      'Loads structured user profiles for the current user.',
    );
    expect(declaration.parameters).toEqual({
      type: Type.OBJECT,
      properties: {},
    });
  });

  it('does not expose the scope to the model', () => {
    const parameters = tool._getDeclaration().parameters;

    expect(parameters?.properties).toEqual({});
    expect(parameters?.required).toBeUndefined();
  });

  it('reads the scope from the invocation context, not from args', async () => {
    const retrieveProfiles = vi
      .spyOn(service, 'retrieveProfiles')
      .mockResolvedValue([]);

    await tool.runAsync({
      args: {app_name: 'attacker-app', user_id: 'attacker-user'},
      toolContext: createToolContext('test-app', 'test-user'),
    });

    expect(retrieveProfiles).toHaveBeenCalledTimes(1);
    expect(retrieveProfiles).toHaveBeenCalledWith({
      appName: 'test-app',
      userId: 'test-user',
    });
  });

  it('filters out profiles with an empty body', async () => {
    vi.spyOn(service, 'retrieveProfiles').mockResolvedValue([
      {schemaId: 'user-profile', profile: {name: 'Kim'}},
      {schemaId: 'empty', profile: {}},
      {schemaId: 'none'},
    ]);

    const result = await tool.runAsync({
      args: {},
      toolContext: createToolContext('test-app', 'test-user'),
    });

    expect(result).toEqual({profiles: [{name: 'Kim'}]});
  });

  it('returns an empty payload when there are no profiles', async () => {
    vi.spyOn(service, 'retrieveProfiles').mockResolvedValue([]);

    const result = await tool.runAsync({
      args: {},
      toolContext: createToolContext('test-app', 'test-user'),
    });

    expect(result).toEqual({profiles: []});
  });

  it('propagates a failure from the memory service', async () => {
    vi.spyOn(service, 'retrieveProfiles').mockRejectedValue(
      new Error('PERMISSION_DENIED'),
    );

    await expect(
      tool.runAsync({
        args: {},
        toolContext: createToolContext('test-app', 'test-user'),
      }),
    ).rejects.toThrow('PERMISSION_DENIED');
  });

  it('registers the tool without adding a system instruction', async () => {
    const llmRequest: LlmRequest = {
      contents: [],
      toolsDict: {},
      liveConnectConfig: {},
    };

    await tool.processLlmRequest({
      toolContext: createToolContext('test-app', 'test-user'),
      llmRequest,
    });

    expect(llmRequest.toolsDict['load_profiles']).toBe(tool);
    const [declaredTool] = llmRequest.config?.tools ?? [];
    if (
      declaredTool === undefined ||
      !('functionDeclarations' in declaredTool)
    ) {
      expect.fail('the tool registered no function declarations');
    }
    expect(declaredTool.functionDeclarations?.[0]?.name).toBe('load_profiles');
    expect(llmRequest.config?.systemInstruction).toBeUndefined();
  });
});
