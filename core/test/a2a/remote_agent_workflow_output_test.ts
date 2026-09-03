/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Part as A2APart, AgentCard} from '@a2a-js/sdk';
import {Client, ClientFactory} from '@a2a-js/sdk/client';
import {
  AsyncQueue,
  createSession,
  Event,
  InvocationContext,
  NodeContext,
  PluginManager,
  RemoteA2AAgent,
} from '@google/adk';
import {describe, expect, it, vi} from 'vitest';

const CARD: AgentCard = {
  name: 'peer',
  description: 'the peer',
  protocolVersion: '0.3.0',
  version: '1.0.0',
  url: 'https://peer.example.com/a2a',
  skills: [],
  capabilities: {streaming: true},
  defaultInputModes: ['text'],
  defaultOutputModes: ['text'],
};

function clientYielding(...chunks: Array<Record<string, unknown>>): {
  client: Client;
  clientFactory: ClientFactory;
} {
  const client = {
    sendMessageStream: vi.fn(() =>
      (async function* () {
        for (const chunk of chunks) {
          yield chunk;
        }
      })(),
    ),
    sendMessage: vi.fn(),
  } as unknown as Client;
  const clientFactory = {
    createFromAgentCard: vi.fn().mockResolvedValue(client),
  } as unknown as ClientFactory;
  return {client, clientFactory};
}

function agentMessage(parts: A2APart[], metadata?: Record<string, unknown>) {
  return {
    kind: 'message',
    messageId: 'm-1',
    role: 'agent',
    parts,
    ...(metadata ? {metadata} : {}),
  };
}

function task(state: string, text: string) {
  return {
    kind: 'task',
    id: 't-1',
    contextId: 'c-1',
    status: {state, message: agentMessage([{kind: 'text', text}])},
  };
}

/** Runs the agent as a workflow node and returns the events it emitted. */
async function runAsNode(agent: RemoteA2AAgent): Promise<Event[]> {
  const invocationContext = new InvocationContext({
    invocationId: 'inv-1',
    pluginManager: new PluginManager([]),
    session: createSession({
      id: 's-1',
      appName: 'app-1',
      events: [
        {
          author: 'user',
          id: 'e-1',
          invocationId: 'inv-1',
          timestamp: 0,
          actions: {
            stateDelta: {},
            artifactDelta: {},
            requestedAuthConfigs: {},
          },
          content: {role: 'user', parts: [{text: 'ping'}]},
        } as unknown as Event,
      ],
    }),
  });
  const channel = new AsyncQueue<Event>();
  const root = new NodeContext({
    invocationContext,
    channel,
    nodePath: '',
    runId: 'root',
  });
  const events: Event[] = [];
  const run = root.runNode(agent, undefined, {useAsOutput: true}).then(
    () => channel.close(),
    (err) => channel.fail(err),
  );
  for await (const event of channel) {
    events.push(event);
  }
  await run;
  return events;
}

function agentFor(...chunks: Array<Record<string, unknown>>): RemoteA2AAgent {
  return new RemoteA2AAgent({
    name: 'peer_agent',
    agentCard: CARD,
    clientFactory: clientYielding(...chunks).clientFactory,
  });
}

describe('RemoteA2AAgent as a workflow node', () => {
  it('promotes the answer text to the node output', async () => {
    const events = await runAsNode(
      agentFor(agentMessage([{kind: 'text', text: 'the answer'}])),
    );

    const promoted = events.find((event) => event.output !== undefined);
    expect(promoted?.output).toBe('the answer');
    expect(promoted?.nodeInfo?.messageAsOutput).toBe(true);
  });

  it('joins several text parts', async () => {
    const events = await runAsNode(
      agentFor(
        agentMessage([
          {kind: 'text', text: 'one '},
          {kind: 'text', text: 'two'},
        ]),
      ),
    );

    expect(events.find((event) => event.output !== undefined)?.output).toBe(
      'one two',
    );
  });

  it('skips thought parts', async () => {
    const events = await runAsNode(
      agentFor(
        agentMessage([
          {kind: 'text', text: 'thinking', metadata: {adk_thought: true}},
          {kind: 'text', text: 'the answer'},
        ]),
      ),
    );

    expect(events.find((event) => event.output !== undefined)?.output).toBe(
      'the answer',
    );
  });

  it('promotes nothing when the peer sent no text', async () => {
    const events = await runAsNode(
      agentFor(
        agentMessage([
          {
            kind: 'data',
            data: {name: 'do_it', args: {}, id: 'fc-1'},
            metadata: {adk_type: 'function_call'},
          },
        ]),
      ),
    );

    expect(events.every((event) => event.output === undefined)).toBe(true);
  });

  it('skips an in-progress task state', async () => {
    const events = await runAsNode(agentFor(task('working', 'still going')));

    expect(events.every((event) => event.output === undefined)).toBe(true);
  });

  it('promotes a completed task state', async () => {
    const events = await runAsNode(agentFor(task('completed', 'all done')));

    expect(events.find((event) => event.output !== undefined)?.output).toBe(
      'all done',
    );
  });

  it('promotes only the first terminal event', async () => {
    const events = await runAsNode(
      agentFor(
        agentMessage([{kind: 'text', text: 'first'}]),
        agentMessage([{kind: 'text', text: 'second'}]),
      ),
    );

    const promoted = events.filter((event) => event.output !== undefined);
    expect(promoted).toHaveLength(1);
    expect(promoted[0].output).toBe('first');
  });

  it('promotes when the peer sends a task with a malformed status', async () => {
    const events = await runAsNode(
      agentFor({
        kind: 'task',
        id: 't-1',
        contextId: 'c-1',
        status: 'completed',
        artifacts: [
          {artifactId: 'a-1', parts: [{kind: 'text', text: 'from artifact'}]},
        ],
      }),
    );

    expect(events.find((event) => event.output !== undefined)?.output).toBe(
      'from artifact',
    );
  });

  it('skips a partial streaming chunk', async () => {
    const events = await runAsNode(
      agentFor({
        kind: 'artifact-update',
        taskId: 't-1',
        contextId: 'c-1',
        append: true,
        lastChunk: false,
        artifact: {artifactId: 'a-1', parts: [{kind: 'text', text: 'partial'}]},
      }),
    );

    expect(events.every((event) => event.output === undefined)).toBe(true);
  });

  it('skips a peer message the converter authors as the user', async () => {
    const events = await runAsNode(
      agentFor({
        kind: 'message',
        messageId: 'm-1',
        role: 'user',
        parts: [{kind: 'text', text: 'relayed'}],
      }),
    );

    expect(events.every((event) => event.output === undefined)).toBe(true);
  });

  it('promotes when the response metadata is absent', async () => {
    const events = await runAsNode(
      agentFor(agentMessage([{kind: 'text', text: 'no metadata'}])),
    );

    expect(events.find((event) => event.output !== undefined)?.output).toBe(
      'no metadata',
    );
  });
});
