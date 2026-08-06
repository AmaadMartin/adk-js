/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  Context,
  createSession,
  InvocationContext,
  LoopAgent,
  OpenAPIToolset,
  PluginManager,
} from '@google/adk';
import * as fs from 'fs';
import * as path from 'path';
import {beforeEach, describe, expect, it, vi} from 'vitest';

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

    // Mock context
    const mockContext = {
      getAuthResponse: vi.fn().mockReturnValue(undefined),
      requestCredential: vi.fn(),
      state: {},
    };

    const result = await getProfileTool!.runAsync({
      args: {id: 'user1', service: 'myservice'},
      toolContext: mockContext as unknown as Context,
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

    const mockContext = {
      getAuthResponse: vi.fn().mockReturnValue(undefined),
      requestCredential: vi.fn(),
      state: {},
    };

    const result = await getProfileTool!.runAsync({
      args: {id: 'user1', service: 'myservice'},
      toolContext: mockContext as unknown as Context,
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

    const mockContext = {
      getAuthResponse: vi.fn().mockReturnValue(undefined),
      requestCredential: vi.fn(),
      state: {},
    };

    const result = await getProfileTool!.runAsync({
      args: {id: 'user1', service: 'myservice'},
      toolContext: mockContext as unknown as Context,
    });

    expect(result).toEqual({
      error: 'Failed to execute API call: Network error',
    });
  });

  it('should snake_case the tool and argument names but send the spec header name', async () => {
    const toolset = new OpenAPIToolset({
      specDict: {
        openapi: '3.0.0',
        info: {title: 'Pet API', version: '1.0.0'},
        servers: [{url: 'https://pets.example.com'}],
        paths: {
          '/pet': {
            get: {
              operationId: 'getPetByID',
              parameters: [
                {
                  name: 'X-Request-Id',
                  in: 'header',
                  required: true,
                  schema: {type: 'string'},
                },
              ],
              responses: {'200': {description: 'OK'}},
            },
          },
        },
      },
    });
    const [tool] = await toolset.getTools();
    if (!tool) {
      expect.fail('the toolset produced no tool for /pet');
    }

    expect(tool.name).toBe('get_pet_by_id');
    const declaration = tool._getDeclaration();
    expect(Object.keys(declaration?.parameters?.properties ?? {})).toEqual([
      'x_request_id',
    ]);

    vi.mocked(globalThis.fetch).mockResolvedValue(
      new Response(JSON.stringify({id: 1}), {
        headers: {'content-type': 'application/json'},
      }),
    );

    await tool.runAsync({
      args: {x_request_id: 'abc'},
      toolContext: new Context({
        invocationContext: new InvocationContext({
          invocationId: 'inv-1',
          agent: new LoopAgent({name: 'test_agent'}),
          session: createSession({id: 'session-1', appName: 'test-app'}),
          pluginManager: new PluginManager(),
        }),
      }),
    });

    expect(globalThis.fetch).toHaveBeenCalledWith(
      'https://pets.example.com/pet',
      expect.objectContaining({
        headers: expect.objectContaining({'X-Request-Id': 'abc'}),
      }),
    );
  });
});
