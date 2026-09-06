/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The behaviour `ManagedAgent` does not share with google/adk-python, kept
 * apart from the ported suite in `managed_agent_test.ts` so both stay legible.
 */

import {
  BuiltInTool,
  createSession,
  Event,
  FunctionTool,
  InvocationContext,
  isManagedAgentInstance,
  isRemoteMcpServer,
  ManagedAgent,
  ManagedAgentConfig,
  PluginManager,
  RemoteMcpServer,
  Session,
  ToolProcessLlmRequest,
} from '@google/adk';
import {GoogleGenAI, Interactions} from '@google/genai';
import {afterEach, describe, expect, it, vi} from 'vitest';
import {driveNode} from '../workflow/test_helpers.js';

/** A tool that drops the request config, as a third-party tool could. */
class ConfigClearingTool extends BuiltInTool {
  constructor() {
    super({name: 'clears_config', description: 'drops the request config'});
  }

  protected override async applyBuiltInConfig({
    llmRequest,
  }: ToolProcessLlmRequest): Promise<void> {
    llmRequest.config = undefined;
  }
}

/** A server-side tool that configures itself onto the request. */
class UrlContextLikeTool extends BuiltInTool {
  constructor() {
    super({name: 'url_context_like', description: 'a server-side tool'});
  }

  protected override async applyBuiltInConfig({
    llmRequest,
  }: ToolProcessLlmRequest): Promise<void> {
    llmRequest.config = llmRequest.config ?? {};
    llmRequest.config.tools = [
      ...(llmRequest.config.tools ?? []),
      {
        urlContext: {},
      },
    ];
  }
}

function devApiClient(): GoogleGenAI {
  return new GoogleGenAI({apiKey: 'test-api-key'});
}

type CreateParams = Interactions.CreateAgentInteractionParamsStreaming;

/** Narrows a decoded request body to the agent-interaction parameters. */
function isAgentParams(body: unknown): body is CreateParams {
  return typeof body === 'object' && body !== null && 'agent' in body;
}

/**
 * Answers every genai HTTP call with an empty stream and records the request,
 * so the SDK's own serialization decides what the assertions see.
 */
function fakeBackend(): {requests: Request[]} {
  const requests: Request[] = [];
  vi.stubGlobal('fetch', async (...args: Parameters<typeof fetch>) => {
    requests.push(new Request(...args));
    return new Response('', {
      status: 200,
      headers: {'content-type': 'text/event-stream'},
    });
  });
  return {requests};
}

/** Decodes the interactions request the agent sent. */
async function requestBody(request: Request): Promise<CreateParams> {
  const body: unknown = await request.json();
  if (!isAgentParams(body)) {
    expect.fail(`expected an agent interaction request, got ${String(body)}`);
  }
  return body;
}

function userCtx(text: string): InvocationContext {
  const session: Session = createSession({
    id: 's1',
    appName: 'test',
    userId: 'user',
  });
  return new InvocationContext({
    invocationId: 'inv1',
    session,
    userContent: {role: 'user', parts: [{text}]},
    pluginManager: new PluginManager(),
  });
}

async function collect(
  agent: ManagedAgent,
  ctx: InvocationContext,
): Promise<Event[]> {
  const events: Event[] = [];
  for await (const event of agent.runAsync(ctx)) {
    events.push(event);
  }
  return events;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('ManagedAgent tool acceptance uses the in-model flag', () => {
  it('accepts a BuiltInTool and forwards what it configured', async () => {
    const backend = fakeBackend();
    const agent = new ManagedAgent({
      name: 'mgr',
      agentId: 'agents/a',
      tools: [new UrlContextLikeTool()],
      apiClient: devApiClient(),
    });

    await collect(agent, userCtx('hi'));

    expect((await requestBody(backend.requests[0])).tools).toEqual([
      {type: 'url_context'},
    ]);
  });

  it('rejects a FunctionTool even though it registers a tools_dict entry', async () => {
    // adk-python decides this by watching `tools_dict` grow. Every adk-js
    // built-in tool registers its name there too, so that signal would reject
    // GOOGLE_SEARCH; the in-model flag is what adk-js reads instead.
    fakeBackend();
    const agent = new ManagedAgent({
      name: 'mgr',
      agentId: 'agents/a',
      tools: [
        new FunctionTool({
          name: 'my_fn',
          description: 'd',
          execute: async () => 'x',
        }),
      ],
      apiClient: devApiClient(),
    });

    await expect(collect(agent, userCtx('hi'))).rejects.toThrow(
      /client-executed tools are not yet supported by ManagedAgent: my_fn/,
    );
  });

  it('rejects an arbitrary object as an unsupported raw tool', async () => {
    fakeBackend();
    const config: ManagedAgentConfig = {
      name: 'mgr',
      agentId: 'agents/a',
      tools: [{}],
      apiClient: devApiClient(),
    };

    await expect(
      collect(new ManagedAgent(config), userCtx('hi')),
    ).rejects.toThrow(/Unsupported raw Tool/);
  });

  it('sends no tools when a tool drops the request config', async () => {
    const backend = fakeBackend();
    const agent = new ManagedAgent({
      name: 'mgr',
      agentId: 'agents/a',
      tools: [new ConfigClearingTool()],
      apiClient: devApiClient(),
    });

    await collect(agent, userCtx('hi'));

    expect('tools' in (await requestBody(backend.requests[0]))).toBe(false);
  });

  it('forwards a code execution tool', async () => {
    const backend = fakeBackend();
    const agent = new ManagedAgent({
      name: 'mgr',
      agentId: 'agents/a',
      tools: [{codeExecution: {}}],
      apiClient: devApiClient(),
    });

    await collect(agent, userCtx('hi'));

    expect((await requestBody(backend.requests[0])).tools).toEqual([
      {type: 'code_execution'},
    ]);
  });

  it('forwards a computer use tool', async () => {
    const backend = fakeBackend();
    const agent = new ManagedAgent({
      name: 'mgr',
      agentId: 'agents/a',
      tools: [{computerUse: {}}],
      apiClient: devApiClient(),
    });

    await collect(agent, userCtx('hi'));

    expect((await requestBody(backend.requests[0])).tools).toEqual([
      {type: 'computer_use'},
    ]);
  });
});

describe('ManagedAgent input', () => {
  it('sends an empty input when the invocation carries no user content', async () => {
    const backend = fakeBackend();
    const agent = new ManagedAgent({
      name: 'mgr',
      agentId: 'agents/a',
      apiClient: devApiClient(),
    });
    const ctx = new InvocationContext({
      invocationId: 'inv1',
      session: createSession({id: 's1', appName: 'test', userId: 'user'}),
      pluginManager: new PluginManager(),
    });

    await collect(agent, ctx);

    expect((await requestBody(backend.requests[0])).input).toEqual([]);
  });
});

describe('ManagedAgent live mode', () => {
  it('rejects live mode', async () => {
    const agent = new ManagedAgent({
      name: 'mgr',
      agentId: 'agents/a',
      apiClient: devApiClient(),
    });

    const run = async () => {
      for await (const _event of agent.runLive(userCtx('hi'))) {
        expect.fail('runLive must not yield an event');
      }
    };

    await expect(run()).rejects.toThrow(/live mode is not supported/);
  });
});

describe('ManagedAgent as a workflow node with no input', () => {
  it('delegates to the base class when the node input is null', async () => {
    const seen: Array<string | undefined> = [];
    class CapturingManagedAgent extends ManagedAgent {
      protected override async *runAsyncImpl(
        ctx: InvocationContext,
      ): AsyncGenerator<Event, void, void> {
        seen.push(ctx.userContent?.parts?.[0].text);
        yield* [];
      }
    }
    const agent = new CapturingManagedAgent({
      name: 'm',
      agentId: 'a',
      apiClient: devApiClient(),
    });

    await driveNode(agent, null);

    expect(seen).toEqual([undefined]);
  });

  it('serializes a node input that is not content', async () => {
    const seen: Array<string | undefined> = [];
    class CapturingManagedAgent extends ManagedAgent {
      protected override async *runAsyncImpl(
        ctx: InvocationContext,
      ): AsyncGenerator<Event, void, void> {
        seen.push(ctx.userContent?.parts?.[0].text);
        yield* [];
      }
    }
    const agent = new CapturingManagedAgent({
      name: 'm',
      agentId: 'a',
      apiClient: devApiClient(),
    });

    await driveNode(agent, {topic: 'volcanoes'});

    expect(seen).toEqual(['{"topic":"volcanoes"}']);
  });
});

describe('type guards survive a second copy of the package', () => {
  it('rejects a plain object shaped like a ManagedAgent', () => {
    const lookalike = {name: 'mgr', agentId: 'agents/a', tools: []};

    expect(isManagedAgentInstance(lookalike)).toBe(false);
    expect(isManagedAgentInstance(null)).toBe(false);
    expect(
      isManagedAgentInstance(
        new ManagedAgent({
          name: 'mgr',
          agentId: 'agents/a',
          apiClient: devApiClient(),
        }),
      ),
    ).toBe(true);
  });

  it('rejects a plain object shaped like a RemoteMcpServer', () => {
    const lookalike = {url: 'https://x/mcp', name: 'x'};

    expect(isRemoteMcpServer(lookalike)).toBe(false);
    expect(isRemoteMcpServer(null)).toBe(false);
    expect(isRemoteMcpServer(new RemoteMcpServer({url: 'https://x/mcp'}))).toBe(
      true,
    );
  });
});
