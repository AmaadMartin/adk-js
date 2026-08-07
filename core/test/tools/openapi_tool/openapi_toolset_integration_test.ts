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
  OpenAPIToolset,
  PluginManager,
} from '@google/adk';
import * as fs from 'fs';
import * as path from 'path';
import {beforeEach, describe, expect, it, vi} from 'vitest';

/**
 * Builds the same real `Context` the agent request loop hands a tool, so the
 * fixture cannot drift from the type `RestApiTool.runAsync` actually receives.
 */
function createToolContext(): Context {
  return new Context({
    invocationContext: new InvocationContext({
      invocationId: 'test-invocation',
      agent: new LlmAgent({name: 'test_agent'}),
      session: createSession({id: 'test-session', appName: 'test-app'}),
      pluginManager: new PluginManager([]),
    }),
  });
}

describe('OpenAPIToolset Integration', () => {
  let truanonSpec: string;

  beforeEach(() => {
    const specPath = path.resolve(__dirname, 'fixtures/truanon.yaml');
    truanonSpec = fs.readFileSync(specPath, 'utf8');

    // Mock global fetch
    globalThis.fetch = vi.fn();
  });

  it('should parse truanon spec and create tools', async () => {
    const toolset = new OpenAPIToolset({
      specStr: truanonSpec,
      specType: 'yaml',
    });
    const tools = await toolset.getTools();

    const toolNames = tools.map((t) => t.name);
    expect(toolNames).toContain('get_profile');
    expect(toolNames).toContain('get_token');
  });

  it('should execute a tool with mocked fetch', async () => {
    const toolset = new OpenAPIToolset({
      specStr: truanonSpec,
      specType: 'yaml',
    });
    const tools = await toolset.getTools();
    const getProfileTool = tools.find((t) => t.name === 'get_profile');

    expect(getProfileTool).toBeTruthy();

    const mockResponse = {status: 'success', data: {confirmed: true}};
    vi.mocked(globalThis.fetch).mockResolvedValue({
      ok: true,
      headers: {get: () => 'application/json'},
      json: async () => mockResponse,
    });

    const result = await getProfileTool!.runAsync({
      args: {id: 'user1', service: 'myservice'},
      toolContext: createToolContext(),
    });

    expect(result).toEqual(mockResponse);
    expect(globalThis.fetch).toHaveBeenCalledWith(
      'https://staging.truanon.com/api/get_profile?id=user1&service=myservice',
      expect.objectContaining({
        method: 'GET',
      }),
    );
  });

  it('should handle non-JSON response', async () => {
    const toolset = new OpenAPIToolset({
      specStr: truanonSpec,
      specType: 'yaml',
    });
    const tools = await toolset.getTools();
    const getProfileTool = tools.find((t) => t.name === 'get_profile');

    vi.mocked(globalThis.fetch).mockResolvedValue({
      ok: true,
      headers: {get: () => 'text/plain'},
      text: async () => 'plain text response',
    });

    const result = await getProfileTool!.runAsync({
      args: {id: 'user1', service: 'myservice'},
      toolContext: createToolContext(),
    });

    expect(result).toBe('plain text response');
  });

  it('should handle fetch error', async () => {
    const toolset = new OpenAPIToolset({
      specStr: truanonSpec,
      specType: 'yaml',
    });
    const tools = await toolset.getTools();
    const getProfileTool = tools.find((t) => t.name === 'get_profile');

    vi.mocked(globalThis.fetch).mockRejectedValue(new Error('Network error'));

    const result = await getProfileTool!.runAsync({
      args: {id: 'user1', service: 'myservice'},
      toolContext: createToolContext(),
    });

    expect(result).toEqual({
      error: 'Failed to execute API call: Network error',
    });
  });
});
