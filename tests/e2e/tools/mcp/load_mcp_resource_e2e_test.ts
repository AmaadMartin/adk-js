/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  ALLOW_CONFIG_STDIO_SERVERS_ENV_VAR,
  Context,
  InvocationContext,
  LlmRequest,
  LoadMcpResourceTool,
  MCPToolset,
  StdioConnectionParams,
} from '@google/adk';
import {fileURLToPath} from 'node:url';
import {afterEach, describe, expect, it} from 'vitest';

/**
 * End-to-end test with NO mocks: a real `MCPToolset` talks to a real MCP server
 * (spawned as a stdio child process, see `mcp_resource_server.mjs`) that exposes
 * a text and a binary resource. This proves the resource path works against an
 * actual MCP server, not just against test doubles.
 */

const SERVER_PATH = fileURLToPath(
  new URL('./mcp_resource_server.mjs', import.meta.url),
);

/** A throwaway tool context; the tool never reads from it. */
const toolContext = {} as unknown as Context;

const stdioConnectionParams: StdioConnectionParams = {
  type: 'StdioConnectionParams',
  serverParams: {command: process.execPath, args: [SERVER_PATH]},
};

function createToolset(): MCPToolset {
  return new MCPToolset(stdioConnectionParams);
}

function functionResponseRequest(resourceNames: string[]): LlmRequest {
  return {
    contents: [
      {
        role: 'user',
        parts: [
          {
            functionResponse: {
              name: 'load_mcp_resource',
              response: {resource_names: resourceNames},
            },
          },
        ],
      },
    ],
    toolsDict: {},
    liveConnectConfig: {},
  };
}

describe('LoadMcpResourceTool (e2e, real MCP server over stdio)', () => {
  let toolset: MCPToolset;

  afterEach(async () => {
    await toolset?.close();
  });

  it('lists, resolves, and reads real MCP resources', async () => {
    toolset = createToolset();

    const names = await toolset.listResources();
    expect(names).toEqual(expect.arrayContaining(['readme', 'logo']));

    const info = await toolset.getResourceInfo('readme');
    expect(info.uri).toBe('file:///readme.txt');

    const textContents = await toolset.readResource('readme');
    expect(textContents[0]).toMatchObject({text: 'hello from mcp resource'});

    const binaryContents = await toolset.readResource('logo');
    expect(binaryContents[0]).toMatchObject({
      blob: Buffer.from('binary-logo-bytes').toString('base64'),
      mimeType: 'image/png',
    });
  });

  it('rejects when reading an unknown resource', async () => {
    toolset = createToolset();

    await expect(toolset.readResource('does-not-exist')).rejects.toThrow(
      'not found',
    );
  });

  it('injects real resource contents into the LlmRequest via the tool', async () => {
    toolset = createToolset();
    const tool = new LoadMcpResourceTool(toolset);
    const llmRequest = functionResponseRequest(['readme', 'logo']);

    await tool.processLlmRequest({toolContext, llmRequest});

    // The server advertises the resources, so the guidance is injected.
    expect(llmRequest.config?.systemInstruction).toContain('readme');

    // The original function-response turn plus one appended turn per resource.
    expect(llmRequest.contents).toHaveLength(3);

    const textTurn = llmRequest.contents[1];
    expect(textTurn.role).toBe('user');
    expect(textTurn.parts?.[0].text).toBe('Resource readme is:');
    expect(textTurn.parts?.[1].text).toBe('hello from mcp resource');

    const binaryTurn = llmRequest.contents[2];
    expect(binaryTurn.parts?.[0].text).toBe('Resource logo is:');
    expect(binaryTurn.parts?.[1].inlineData?.mimeType).toBe('image/png');
    expect(binaryTurn.parts?.[1].inlineData?.data).toBe(
      Buffer.from('binary-logo-bytes').toString('base64'),
    );
  });
});

describe('MCPToolset useMcpResources (e2e, real MCP server over stdio)', () => {
  let toolset: MCPToolset;

  afterEach(async () => {
    delete process.env[ALLOW_CONFIG_STDIO_SERVERS_ENV_VAR];
    await toolset?.close();
  });

  it('omits the resource tool when the option is off', async () => {
    toolset = createToolset();

    const names = (await toolset.getTools()).map((tool) => tool.name);

    expect(names).toEqual(['alpha', 'counter', 'echo']);
  });

  it('appends the resource tool after the server tools', async () => {
    toolset = new MCPToolset({
      connectionParams: stdioConnectionParams,
      useMcpResources: true,
    });

    const names = (await toolset.getTools()).map((tool) => tool.name);

    expect(names).toEqual(['alpha', 'counter', 'echo', 'load_mcp_resource']);
  });

  it('reaches real resource contents through the appended tool', async () => {
    toolset = new MCPToolset({
      connectionParams: stdioConnectionParams,
      useMcpResources: true,
    });
    const tools = await toolset.getTools();
    const llmRequest = functionResponseRequest(['readme']);

    await tools[tools.length - 1].processLlmRequest({toolContext, llmRequest});

    expect(llmRequest.contents).toHaveLength(2);
    expect(llmRequest.contents[1].parts?.[1].text).toBe(
      'hello from mcp resource',
    );
  });

  it('builds the same toolset through fromConfig once stdio is allowed', async () => {
    process.env[ALLOW_CONFIG_STDIO_SERVERS_ENV_VAR] = '1';
    toolset = MCPToolset.fromConfig({
      stdioConnectionParams,
      useMcpResources: true,
    });

    const names = (await toolset.getTools()).map((tool) => tool.name);

    expect(names).toEqual(['alpha', 'counter', 'echo', 'load_mcp_resource']);
  });

  it('refuses the same config while stdio is not allowed', () => {
    delete process.env[ALLOW_CONFIG_STDIO_SERVERS_ENV_VAR];

    expect(() => MCPToolset.fromConfig({stdioConnectionParams})).toThrow(
      /not allowed in agent configs/,
    );
  });
});

describe('MCPToolset tool discovery (e2e, real MCP server over stdio)', () => {
  let toolset: MCPToolset;

  afterEach(async () => {
    await toolset?.close();
  });

  it('sorts by name and drops the reserved name the server advertises', async () => {
    toolset = createToolset();

    const names = (await toolset.getTools()).map((tool) => tool.name);

    // The server advertises echo, alpha, transfer_to_agent, counter.
    expect(names).toEqual(['alpha', 'counter', 'echo']);
  });

  it('lists once within the cache lifetime', async () => {
    toolset = new MCPToolset({
      connectionParams: stdioConnectionParams,
      toolListCacheTtlSeconds: 60,
    });

    const first = await toolset.getTools();
    const second = await toolset.getTools();

    expect(second.map((tool) => tool.name)).toEqual(
      first.map((tool) => tool.name),
    );
  });

  it('receives the progress the server reports during a call', async () => {
    const reported: number[] = [];
    toolset = new MCPToolset({
      connectionParams: stdioConnectionParams,
      progressCallback: ({progress}) => {
        reported.push(progress);
      },
    });

    const tools = await toolset.getTools();
    const counter = tools.find((tool) => tool.name === 'counter');
    if (!counter) {
      expect.fail('the server did not advertise the counter tool');
    }
    await counter.runAsync({args: {}, toolContext});

    // The server sends two updates, but the tool result can overtake the last
    // one on the wire. The first update is enough to prove the SDK sent a
    // progress token and the callback received what the server reported.
    expect(reported).toContain(1);
  });

  it('holds a gated call back from the server', async () => {
    toolset = new MCPToolset({
      connectionParams: stdioConnectionParams,
      requireConfirmation: true,
    });
    const gatedContext = new Context({
      invocationContext: {
        abortSignal: new AbortController().signal,
        session: {state: {}},
      } as unknown as InvocationContext,
      functionCallId: 'call-1',
    });

    const tools = await toolset.getTools();
    const echo = tools.find((tool) => tool.name === 'echo');
    if (!echo) {
      expect.fail('the server did not advertise the echo tool');
    }
    const result = await echo.runAsync({args: {}, toolContext: gatedContext});

    expect(result).toEqual({
      error: 'This tool call requires confirmation, please approve or reject.',
    });
  });
});
