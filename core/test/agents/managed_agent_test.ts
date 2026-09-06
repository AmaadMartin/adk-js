/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * adk-js-specific coverage for `ManagedAgent` and `RemoteMcpServer`. The ported
 * reference suite lives in `managed_agent_parity_test.ts`.
 *
 * Four reference tests answer at compile time in TypeScript and are kept here
 * under their reference names: `test_mode_chat_is_rejected`,
 * `test_remote_mcp_server_forbids_extra_fields`,
 * `test_resolve_rejects_plain_callable` and
 * `test_tools_import_first_has_no_cycle`. Each says at its own site how the
 * compile-time form stands in for the reference's runtime one. The type
 * assertions are checked by `npm run ts:check`, which covers `core/test`.
 */

import {
  BaseTool,
  Context,
  createSession,
  Event,
  GoogleSearchTool,
  InMemorySessionService,
  InvocationContext,
  isManagedAgent,
  isRemoteMcpServer,
  LlmRequest,
  ManagedAgent,
  ManagedAgentClient,
  ManagedAgentConfig,
  ManagedAgentTool,
  PluginManager,
  RemoteMcpServer,
  UrlContextTool,
} from '@google/adk';
import {resolveClientLocation} from '@google/adk/agents/managed_agent.js';
import {Tool} from '@google/genai';
import {readFile} from 'node:fs/promises';
import {describe, expect, expectTypeOf, it} from 'vitest';

interface FakeClient extends ManagedAgentClient {
  apiClient?: {getLocation(): unknown};
}

function fakeClient(location?: unknown): FakeClient {
  return {
    vertexai: true,
    interactions: {create: () => Promise.resolve(undefined)},
    apiClient: {getLocation: () => location},
  };
}

function invocationContext(): InvocationContext {
  return new InvocationContext({
    invocationId: 'inv1',
    session: createSession({id: 's1', appName: 'test', userId: 'user'}),
    sessionService: new InMemorySessionService(),
    pluginManager: new PluginManager([]),
  });
}

/** Runs the agent as a workflow-free turn and collects its events. */
async function runAgent(agent: ManagedAgent): Promise<Event[]> {
  const events: Event[] = [];
  for await (const event of agent.runAsync(invocationContext())) {
    events.push(event);
  }
  return events;
}

describe('ManagedAgent', () => {
  describe('compile-time rejections that the reference checks at runtime', () => {
    it('test_mode_chat_is_rejected', () => {
      // The reference catches a pydantic ValidationError. Here `mode` is a
      // literal union, so `'chat'` never compiles; pinning the union is the
      // assertion.
      expectTypeOf<ManagedAgentConfig['mode']>().toEqualTypeOf<
        'single_turn' | undefined
      >();
    });

    it('test_remote_mcp_server_forbids_extra_fields', () => {
      // The reference asserts pydantic's `extra='forbid'`. TypeScript rejects
      // an unknown property on an object literal at compile time, so there is
      // no runtime error to catch; pinning the key set is the assertion.
      expectTypeOf<keyof RemoteMcpServer>().toEqualTypeOf<
        'url' | 'name' | 'headers' | 'allowedTools' | 'headerProvider'
      >();
    });

    it('test_resolve_rejects_plain_callable', () => {
      // adk-js has no bare-callable tool form, so the reference's
      // `Callable[..., Any]` arm does not exist in the union and a function is
      // rejected before the agent runs.
      expectTypeOf<() => string>().not.toExtend<ManagedAgentTool>();
      expectTypeOf<ManagedAgentTool>().toEqualTypeOf<
        Tool | BaseTool | RemoteMcpServer
      >();
    });

    it('test_tools_import_first_has_no_cycle', async () => {
      // The reference spawns a subprocess to prove importing the tools package
      // first does not cycle. ES modules have no equivalent failure, so the
      // invariant is asserted directly: the module must have no runtime import
      // at all, which is what keeps it a leaf. A `type`-only import is erased.
      const source = await readFile(
        new URL('../../src/tools/remote_mcp_server.ts', import.meta.url),
        'utf8',
      );
      const runtimeImports = [
        ...source.matchAll(/^import\s+(?!type\b)[^;]*from\s+'([^']+)';/gm),
      ].map((match) => match[1]);

      expect(runtimeImports).toEqual([]);
    });
  });

  describe('isManagedAgent', () => {
    it('accepts a ManagedAgent', () => {
      expect(isManagedAgent(new ManagedAgent({name: 'm', agentId: 'a'}))).toBe(
        true,
      );
    });

    it('rejects a value that is not a ManagedAgent', () => {
      expect(isManagedAgent(undefined)).toBe(false);
      expect(isManagedAgent(null)).toBe(false);
      expect(isManagedAgent('managed')).toBe(false);
      expect(isManagedAgent({name: 'm', agentId: 'a'})).toBe(false);
    });
  });

  describe('isRemoteMcpServer', () => {
    it('accepts a spec carrying a string url', () => {
      expect(isRemoteMcpServer({url: 'https://x/mcp'})).toBe(true);
    });

    it('rejects a value with no string url', () => {
      expect(isRemoteMcpServer(undefined)).toBe(false);
      expect(isRemoteMcpServer(null)).toBe(false);
      expect(isRemoteMcpServer('https://x/mcp')).toBe(false);
      expect(isRemoteMcpServer({})).toBe(false);
      expect(isRemoteMcpServer({url: 42})).toBe(false);
    });

    it('rejects a BaseTool, which the resolver tests before a server spec', () => {
      expect(isRemoteMcpServer(new GoogleSearchTool())).toBe(false);
    });
  });

  describe('resolveClientLocation', () => {
    it('returns the location a client resolves to', () => {
      expect(resolveClientLocation(fakeClient('global'))).toBe('global');
    });

    it('returns undefined when the accessor yields a non-string', () => {
      expect(resolveClientLocation(fakeClient(undefined))).toBeUndefined();
    });

    it('returns undefined when the client exposes no accessor', () => {
      const client: ManagedAgentClient = {
        vertexai: true,
        interactions: {create: () => Promise.resolve(undefined)},
      };

      expect(resolveClientLocation(client)).toBeUndefined();
    });
  });

  describe('runLive', () => {
    it('throws, because the live API serves no Managed Agents surface', async () => {
      const agent = new ManagedAgent({
        name: 'm',
        agentId: 'a',
        apiClient: fakeClient('global'),
      });

      const events = agent.runLive(invocationContext());

      await expect(events.next()).rejects.toThrow(/does not support live/);
    });
  });

  describe('tool resolution in managed-agent mode', () => {
    it('configures a built-in tool that would otherwise need a model', async () => {
      const llmRequest: LlmRequest = {
        contents: [],
        config: {},
        liveConnectConfig: {},
        toolsDict: {},
        isManagedAgent: true,
      };

      await new GoogleSearchTool().processLlmRequest({
        toolContext: new Context({invocationContext: invocationContext()}),
        llmRequest,
      });
      await new UrlContextTool().processLlmRequest({
        toolContext: new Context({invocationContext: invocationContext()}),
        llmRequest,
      });

      expect(llmRequest.config?.tools).toEqual([
        {googleSearch: {}},
        {urlContext: {}},
      ]);
    });

    it('rejects a raw Tool that carries no server-side field', async () => {
      const empty: Tool = {};
      const agent = new ManagedAgent({
        name: 'mgr',
        agentId: 'agents/a',
        tools: [empty],
        apiClient: fakeClient('global'),
      });

      await expect(runAgent(agent)).rejects.toThrow(/Unsupported raw/);
    });
  });

  describe('event construction', () => {
    it('keeps the agent as the author when a response carries no author', async () => {
      const agent = new ManagedAgent({
        name: 'mgr',
        agentId: 'agents/a',
        apiClient: fakeClient('global'),
      });

      // The client double resolves to undefined, so the transport rejects it
      // and the agent turns that into its terminal error event.
      const events = await runAgent(agent);

      expect(events).toHaveLength(1);
      expect(events[0].author).toBe('mgr');
      expect(events[0].invocationId).toBe('inv1');
      expect(events[0].errorCode).toBe('UNKNOWN_ERROR');
      expect(events[0].errorMessage).toContain('non-streaming response');
      expect(events[0].turnComplete).toBe(true);
    });
  });
});
