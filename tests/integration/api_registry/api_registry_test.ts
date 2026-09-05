/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  AgentRegistrySingleMCPToolset,
  ApiRegistry,
  Event,
  LlmAgent,
} from '@google/adk';
import {StreamableHTTPClientTransport} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {beforeEach, describe, expect, it, vi} from 'vitest';
import {
  createRunner,
  GeminiWithMockResponses,
  RawGenerateContentResponse,
} from '../test_case_utils.js';

vi.mock('google-auth-library', () => ({
  GoogleAuth: vi.fn().mockImplementation(() => ({
    getClient: vi.fn().mockResolvedValue({
      getAccessToken: vi.fn().mockResolvedValue({token: 'fake-token'}),
      quotaProjectId: 'quota-project-123',
    }),
  })),
}));

const mockMcpClient = {
  connect: vi.fn().mockResolvedValue(undefined),
  close: vi.fn().mockResolvedValue(undefined),
  listTools: vi.fn().mockResolvedValue({
    tools: [
      {
        name: 'retrieve_billing_data',
        description: 'Retrieves GCP billing info',
        inputSchema: {type: 'object', properties: {}},
      },
    ],
  }),
};

vi.mock('@modelcontextprotocol/sdk/client/index.js', () => ({
  Client: vi.fn().mockImplementation(() => mockMcpClient),
}));

vi.mock('@modelcontextprotocol/sdk/client/streamableHttp.js', () => ({
  StreamableHTTPClientTransport: vi.fn().mockImplementation(() => ({})),
}));

describe('ApiRegistry Integration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    global.fetch = vi.fn<typeof fetch>().mockImplementation(async () =>
      Response.json({
        mcpServers: [{name: 'billing-server', urls: ['billing-mcp.com/v1']}],
      }),
    );
  });

  it('resolves a registry toolset and runs it inside an LlmAgent', async () => {
    const registry = new ApiRegistry({
      projectId: 'gcp-integration-project',
      location: 'us-central1',
    });

    const toolset = await registry.getToolset('billing-server', {
      toolNamePrefix: 'billing',
    });
    expect(toolset).toBeInstanceOf(AgentRegistrySingleMCPToolset);

    const tools = await toolset.getTools();
    expect(tools.map((tool) => tool.name)).toEqual([
      'billing_retrieve_billing_data',
    ]);

    // billing-mcp.com is not a Google API host, so it must receive no
    // Application Default Credentials.
    const transportCall = vi
      .mocked(StreamableHTTPClientTransport)
      .mock.calls.at(-1);
    if (!transportCall) {
      expect.fail('StreamableHTTPClientTransport received no call');
    }
    expect(transportCall[0].toString()).toBe('https://billing-mcp.com/v1');
    expect(transportCall[1]?.requestInit?.headers).toEqual({});

    const mockLlmResponses: RawGenerateContentResponse[] = [
      {
        candidates: [
          {
            content: {
              parts: [{text: 'Retrieved GCP billing info: $0.00'}],
              role: 'model',
            },
          },
        ],
      },
    ];

    const agent = new LlmAgent({
      model: new GeminiWithMockResponses(mockLlmResponses),
      name: 'billingAssistant',
      description: 'Assistant with registry-loaded billing tools',
      instruction: 'Use the billing tools to answer user queries',
      tools: [toolset],
    });

    const {run} = await createRunner(agent);

    const events: Event[] = [];
    for await (const event of run('Check my billing status')) {
      events.push(event);
    }

    expect(events.length).toBeGreaterThan(0);
    expect(events[events.length - 1].content?.parts?.[0]?.text).toBe(
      'Retrieved GCP billing info: $0.00',
    );
  });
});
