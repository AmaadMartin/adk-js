/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {toMcpServer as publicToMcpServer} from '@google/adk';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {InMemoryTransport} from '@modelcontextprotocol/sdk/inMemory.js';
import {McpServer} from '@modelcontextprotocol/sdk/server/mcp.js';
import {RequestHandlerExtra} from '@modelcontextprotocol/sdk/shared/protocol.js';
import {
  AudioContent,
  CallToolResult,
  CallToolResultSchema,
  ContentBlock,
  EmbeddedResource,
  ImageContent,
  ServerNotification,
  ServerRequest,
  TextContent,
} from '@modelcontextprotocol/sdk/types.js';
import {afterEach, describe, expect, it, vi} from 'vitest';
import {BaseAgent, isBaseAgent} from '../../../src/agents/base_agent.js';
import {InvocationContext} from '../../../src/agents/invocation_context.js';
import {createEvent, Event} from '../../../src/events/event.js';
import {Runner} from '../../../src/runner/runner.js';
import {InMemorySessionService} from '../../../src/sessions/in_memory_session_service.js';
import {
  partToContent,
  runAgent,
  toMcpServer,
} from '../../../src/tools/mcp/agent_to_mcp.js';

/** The wire-observable user id every MCP-driven conversation runs under. */
const MCP_USER_ID = 'mcp_user';

/** The wire-observable URI for inline data that is neither image nor audio. */
const INLINE_RESOURCE_URI = 'resource://adk-agent/inline-data';

const APP_NAME = 'agent_to_mcp_app';
const AGENT_NAME = 'my_agent';

/** An agent that replays a fixed event script. */
class ScriptedAgent extends BaseAgent {
  private readonly events: Event[];

  constructor(config: {name: string; description?: string; events: Event[]}) {
    super({name: config.name, description: config.description});
    this.events = config.events;
  }

  protected async *runAsyncImpl(
    _context: InvocationContext,
  ): AsyncGenerator<Event, void, void> {
    for (const event of this.events) {
      yield event;
    }
  }

  protected async *runLiveImpl(
    _context: InvocationContext,
  ): AsyncGenerator<Event, void, void> {}
}

function textEvent(text: string, options: {partial?: boolean} = {}): Event {
  return createEvent({
    author: AGENT_NAME,
    partial: options.partial,
    content: {role: 'model', parts: [{text}]},
  });
}

function inlineDataEvent(data: string, mimeType?: string): Event {
  return createEvent({
    author: AGENT_NAME,
    content: {role: 'model', parts: [{inlineData: {data, mimeType}}]},
  });
}

function createRunner(events: Event[], appName = APP_NAME): Runner {
  return new Runner({
    appName,
    agent: new ScriptedAgent({name: AGENT_NAME, events}),
    sessionService: new InMemorySessionService(),
  });
}

/**
 * The runner's root as an agent. `Runner.agent` is a `RunnableRoot`, which a
 * workflow also satisfies, and `toMcpServer` takes an agent.
 */
function rootAgent(runner: Runner): BaseAgent {
  const agent = runner.agent;
  if (!isBaseAgent(agent)) {
    throw new Error('Expected the runner root to be an agent.');
  }
  return agent;
}

async function startSession(runner: Runner): Promise<string> {
  const session = await runner.sessionService.createSession({
    appName: runner.appName,
    userId: MCP_USER_ID,
  });
  return session.id;
}

function createToolCallExtra(options: {
  sendNotification: (notification: ServerNotification) => Promise<void>;
  progressToken?: string | number;
}): RequestHandlerExtra<ServerRequest, ServerNotification> {
  return {
    signal: new AbortController().signal,
    requestId: 1,
    _meta:
      options.progressToken === undefined
        ? undefined
        : {progressToken: options.progressToken},
    sendNotification: options.sendNotification,
    sendRequest: () => Promise.reject(new Error('sendRequest is unused')),
  };
}

const openPairs: Array<{client: Client; server: McpServer}> = [];

/** Connects a client to the server over a linked in-process transport pair. */
async function connect(server: McpServer): Promise<Client> {
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  const client = new Client({name: 'test_client', version: '1.0.0'});
  await Promise.all([
    client.connect(clientTransport),
    server.connect(serverTransport),
  ]);
  openPairs.push({client, server});
  return client;
}

/** Validates a tool result against the MCP schema and returns it typed. */
function toolResult(result: unknown): CallToolResult {
  return CallToolResultSchema.parse(result);
}

function expectTextBlock(block: ContentBlock | undefined): TextContent {
  if (block?.type !== 'text') {
    expect.fail(`expected a text block, got ${JSON.stringify(block)}`);
  }
  return block;
}

function expectImageBlock(block: ContentBlock | undefined): ImageContent {
  if (block?.type !== 'image') {
    expect.fail(`expected an image block, got ${JSON.stringify(block)}`);
  }
  return block;
}

function expectAudioBlock(block: ContentBlock | undefined): AudioContent {
  if (block?.type !== 'audio') {
    expect.fail(`expected an audio block, got ${JSON.stringify(block)}`);
  }
  return block;
}

function expectResourceBlock(
  block: ContentBlock | undefined,
): EmbeddedResource {
  if (block?.type !== 'resource') {
    expect.fail(`expected a resource block, got ${JSON.stringify(block)}`);
  }
  return block;
}

afterEach(async () => {
  for (const {client, server} of openPairs.splice(0)) {
    await client.close();
    await server.close();
  }
});

describe('toMcpServer', () => {
  it('is exported from the package entry point', () => {
    expect(publicToMcpServer).toBe(toMcpServer);
  });

  it('registers the agent as a single tool', async () => {
    const agent = new ScriptedAgent({
      name: AGENT_NAME,
      description: 'does useful things',
      events: [],
    });

    const client = await connect(toMcpServer(agent));
    const {tools} = await client.listTools();

    expect(tools).toHaveLength(1);
    expect(tools[0].name).toBe(AGENT_NAME);
    expect(tools[0].description).toBe('does useful things');
    expect(tools[0].inputSchema.properties).toHaveProperty('request');
  });

  it('uses the name from the options over the agent name', async () => {
    const agent = new ScriptedAgent({name: AGENT_NAME, events: []});

    const client = await connect(toMcpServer(agent, {name: 'custom'}));
    const {tools} = await client.listTools();

    expect(tools[0].name).toBe('custom');
  });

  it('falls back to a generated description when the agent has none', async () => {
    const agent = new ScriptedAgent({name: AGENT_NAME, events: []});

    const client = await connect(toMcpServer(agent));
    const {tools} = await client.listTools();

    expect(tools[0].description).toBe('Run the my_agent agent.');
  });

  it('passes the instructions to the MCP server', async () => {
    const agent = new ScriptedAgent({name: AGENT_NAME, events: []});

    const client = await connect(
      toMcpServer(agent, {instructions: 'Ask the agent anything.'}),
    );

    expect(client.getInstructions()).toBe('Ask the agent anything.');
  });

  it('runs the agent end to end when the tool is called', async () => {
    const agent = new ScriptedAgent({
      name: AGENT_NAME,
      events: [textEvent('hello from the agent')],
    });

    const client = await connect(toMcpServer(agent));
    const result = toolResult(
      await client.callTool({name: AGENT_NAME, arguments: {request: 'hi'}}),
    );

    expect(result.isError).toBeFalsy();
    expect(expectTextBlock(result.content[0]).text).toBe(
      'hello from the agent',
    );
  });

  it('builds an in-memory runner when none is supplied', async () => {
    const agent = new ScriptedAgent({
      name: AGENT_NAME,
      events: [textEvent('default services work')],
    });

    const client = await connect(toMcpServer(agent));
    const result = toolResult(
      await client.callTool({name: AGENT_NAME, arguments: {request: 'hi'}}),
    );

    expect(result.isError).toBeFalsy();
    expect(expectTextBlock(result.content[0]).text).toBe(
      'default services work',
    );
  });

  it('runs the agent on the supplied runner', async () => {
    const runner = createRunner([textEvent('ok')], 'byo_runner_app');
    const createSession = vi.spyOn(runner.sessionService, 'createSession');

    const client = await connect(toMcpServer(rootAgent(runner), {runner}));
    await client.callTool({name: AGENT_NAME, arguments: {request: 'hi'}});

    expect(createSession).toHaveBeenCalledTimes(1);
    expect(createSession).toHaveBeenCalledWith({
      appName: 'byo_runner_app',
      userId: MCP_USER_ID,
    });
  });

  it('reuses one session across calls on one connection', async () => {
    const runner = createRunner([textEvent('ok')]);
    const createSession = vi.spyOn(runner.sessionService, 'createSession');
    const runAsync = vi.spyOn(runner, 'runAsync');

    const client = await connect(toMcpServer(rootAgent(runner), {runner}));
    await client.callTool({name: AGENT_NAME, arguments: {request: 'first'}});
    await client.callTool({name: AGENT_NAME, arguments: {request: 'second'}});

    expect(createSession).toHaveBeenCalledTimes(1);
    const [first, second] = runAsync.mock.calls;
    expect(first[0].sessionId).toBe(second[0].sessionId);
  });

  it('creates the session once when calls overlap', async () => {
    const runner = createRunner([textEvent('ok')]);
    const createSession = vi.spyOn(runner.sessionService, 'createSession');

    const client = await connect(toMcpServer(rootAgent(runner), {runner}));
    await Promise.all([
      client.callTool({name: AGENT_NAME, arguments: {request: 'first'}}),
      client.callTool({name: AGENT_NAME, arguments: {request: 'second'}}),
    ]);

    expect(createSession).toHaveBeenCalledTimes(1);
  });

  it('uses a separate session for each server', async () => {
    const runner = createRunner([textEvent('ok')]);
    const createSession = vi.spyOn(runner.sessionService, 'createSession');
    const runAsync = vi.spyOn(runner, 'runAsync');

    const firstClient = await connect(toMcpServer(rootAgent(runner), {runner}));
    const secondClient = await connect(
      toMcpServer(rootAgent(runner), {runner}),
    );
    await firstClient.callTool({name: AGENT_NAME, arguments: {request: 'a'}});
    await secondClient.callTool({name: AGENT_NAME, arguments: {request: 'b'}});

    expect(createSession).toHaveBeenCalledTimes(2);
    const [first, second] = runAsync.mock.calls;
    expect(first[0].sessionId).not.toBe(second[0].sessionId);
  });

  it('retries session creation after a failed attempt', async () => {
    const runner = createRunner([textEvent('ok')]);
    const createSession = vi
      .spyOn(runner.sessionService, 'createSession')
      .mockRejectedValueOnce(new Error('session store unavailable'));

    const client = await connect(toMcpServer(rootAgent(runner), {runner}));
    const failed = toolResult(
      await client.callTool({name: AGENT_NAME, arguments: {request: 'first'}}),
    );
    const recovered = toolResult(
      await client.callTool({name: AGENT_NAME, arguments: {request: 'second'}}),
    );

    expect(failed.isError).toBe(true);
    expect(expectTextBlock(failed.content[0]).text).toContain(
      'session store unavailable',
    );
    expect(recovered.isError).toBeFalsy();
    expect(expectTextBlock(recovered.content[0]).text).toBe('ok');
    expect(createSession).toHaveBeenCalledTimes(2);
  });

  it('delivers intermediate events to the host as progress notifications', async () => {
    const runner = createRunner([
      textEvent('thinking', {partial: true}),
      textEvent('done'),
    ]);
    const reported: Array<string | undefined> = [];

    const client = await connect(toMcpServer(rootAgent(runner), {runner}));
    const result = toolResult(
      await client.callTool(
        {name: AGENT_NAME, arguments: {request: 'hi'}},
        undefined,
        {onprogress: (progress) => reported.push(progress.message)},
      ),
    );

    expect(reported).toEqual(['thinking']);
    expect(expectTextBlock(result.content[0]).text).toBe('done');
  });
});

describe('runAgent', () => {
  it('returns only the final response content', async () => {
    const runner = createRunner([
      textEvent('thinking', {partial: true}),
      textEvent('answer'),
    ]);

    const content = await runAgent(runner, 'hi', await startSession(runner));

    expect(content).toEqual([{type: 'text', text: 'answer'}]);
  });

  it('reports intermediate events as progress', async () => {
    const runner = createRunner([
      textEvent('thinking', {partial: true}),
      textEvent('done'),
    ]);
    const sendNotification = vi.fn(async () => {});

    const content = await runAgent(
      runner,
      'hi',
      await startSession(runner),
      createToolCallExtra({sendNotification, progressToken: 'token-1'}),
    );

    expect(sendNotification).toHaveBeenCalledTimes(1);
    expect(sendNotification).toHaveBeenCalledWith({
      method: 'notifications/progress',
      params: {progressToken: 'token-1', progress: 0, message: 'thinking'},
    });
    expect(expectTextBlock(content[0]).text).toBe('done');
  });

  it('sends no progress when the host supplied no progress token', async () => {
    const runner = createRunner([
      textEvent('thinking', {partial: true}),
      textEvent('done'),
    ]);
    const sendNotification = vi.fn(async () => {});

    await runAgent(
      runner,
      'hi',
      await startSession(runner),
      createToolCallExtra({sendNotification}),
    );

    expect(sendNotification).not.toHaveBeenCalled();
  });

  it('sends no progress for an intermediate event with no text', async () => {
    const runner = createRunner([
      createEvent({
        author: AGENT_NAME,
        partial: true,
        content: {role: 'model', parts: [{thought: true}]},
      }),
      textEvent('done'),
    ]);
    const sendNotification = vi.fn(async () => {});

    await runAgent(
      runner,
      'hi',
      await startSession(runner),
      createToolCallExtra({sendNotification, progressToken: 7}),
    );

    expect(sendNotification).not.toHaveBeenCalled();
  });

  it('drops intermediate events when no tool call context is supplied', async () => {
    const runner = createRunner([
      textEvent('thinking', {partial: true}),
      textEvent('done'),
    ]);

    const content = await runAgent(runner, 'hi', await startSession(runner));

    expect(content).toEqual([{type: 'text', text: 'done'}]);
  });

  it('skips events that carry no content parts', async () => {
    const runner = createRunner([
      createEvent({author: AGENT_NAME}),
      createEvent({author: AGENT_NAME, content: {role: 'model', parts: []}}),
      textEvent('answer'),
    ]);

    const content = await runAgent(runner, 'hi', await startSession(runner));

    expect(content).toEqual([{type: 'text', text: 'answer'}]);
  });

  it('maps image output to an image block without re-encoding it', async () => {
    const original = 'PNG-BYTES';
    const data = Buffer.from(original).toString('base64');
    const runner = createRunner([inlineDataEvent(data, 'image/png')]);

    const content = await runAgent(runner, 'draw', await startSession(runner));

    const block = expectImageBlock(content[0]);
    expect(block.mimeType).toBe('image/png');
    expect(Buffer.from(block.data, 'base64').toString()).toBe(original);
  });

  it('maps audio output to an audio block', async () => {
    const data = Buffer.from('MP3-BYTES').toString('base64');
    const runner = createRunner([inlineDataEvent(data, 'audio/mpeg')]);

    const content = await runAgent(runner, 'speak', await startSession(runner));

    const block = expectAudioBlock(content[0]);
    expect(block.mimeType).toBe('audio/mpeg');
    expect(block.data).toBe(data);
  });

  it('maps other inline data to an embedded resource', async () => {
    const data = Buffer.from('%PDF-1.7').toString('base64');
    const runner = createRunner([inlineDataEvent(data, 'application/pdf')]);

    const content = await runAgent(
      runner,
      'report',
      await startSession(runner),
    );

    expect(expectResourceBlock(content[0]).resource).toEqual({
      uri: INLINE_RESOURCE_URI,
      blob: data,
      mimeType: 'application/pdf',
    });
  });

  it('returns an empty array when the agent emits nothing renderable', async () => {
    const runner = createRunner([
      createEvent({
        author: AGENT_NAME,
        content: {
          role: 'model',
          parts: [
            {fileData: {fileUri: 'gs://bucket/report.pdf'}},
            {inlineData: {mimeType: 'image/png'}},
          ],
        },
      }),
    ]);

    const content = await runAgent(runner, 'hi', await startSession(runner));

    expect(content).toEqual([]);
  });
});

describe('partToContent', () => {
  it('defaults the mime type when the inline data declares none', () => {
    const block = partToContent({inlineData: {data: 'AAAA'}});

    expect(expectResourceBlock(block).resource).toEqual({
      uri: INLINE_RESOURCE_URI,
      blob: 'AAAA',
      mimeType: 'application/octet-stream',
    });
  });

  it('keeps an empty inline payload', () => {
    const block = partToContent({inlineData: {data: '', mimeType: 'text/csv'}});

    expect(expectResourceBlock(block).resource).toEqual({
      uri: INLINE_RESOURCE_URI,
      blob: '',
      mimeType: 'text/csv',
    });
  });

  it('returns undefined for a part with nothing renderable', () => {
    expect(partToContent({functionCall: {name: 'roll_die', args: {}}})).toBe(
      undefined,
    );
  });
});
