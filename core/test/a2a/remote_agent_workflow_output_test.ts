/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  Part as A2APart,
  AgentCard,
  Message,
  Task,
  TaskState,
} from '@a2a-js/sdk';
import {Client, ClientFactory} from '@a2a-js/sdk/client';
import {
  A2AStreamEventData,
  AsyncQueue,
  createEvent,
  createSession,
  Event,
  InvocationContext,
  NodeContext,
  PluginManager,
  RemoteA2AAgent,
} from '@google/adk';
import {describe, expect, it, vi} from 'vitest';
import {promoteResponseToOutput} from '../../src/a2a/a2a_remote_agent_output.js';
import {fakeA2AClient, fakeClientFactory} from './fake_a2a_client.js';

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

function clientYielding(...chunks: A2AStreamEventData[]): {
  client: Client;
  clientFactory: ClientFactory;
} {
  const client = fakeA2AClient({
    sendMessageStream: vi.fn(async function* () {
      for (const chunk of chunks) {
        yield chunk;
      }
    }),
    sendMessage: vi.fn(),
  });
  const clientFactory = fakeClientFactory(vi.fn().mockResolvedValue(client));
  return {client, clientFactory};
}

function agentMessage(parts: A2APart[]): Message {
  return {kind: 'message', messageId: 'm-1', role: 'agent', parts};
}

function task(state: TaskState, text: string): Task {
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
        createEvent({
          author: 'user',
          invocationId: 'inv-1',
          content: {role: 'user', parts: [{text: 'ping'}]},
        }),
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

function agentFor(...chunks: A2AStreamEventData[]): RemoteA2AAgent {
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

/**
 * The response metadata is whatever the peer sent, so its shape is not
 * guaranteed. The client double is typed to the SDK, which is what a healthy
 * server produces; these drive the narrowing directly with the shapes a
 * buggy or hostile one can produce.
 */
describe('promoteResponseToOutput', () => {
  function peerEvent(response?: unknown): Event {
    return createEvent({
      author: 'peer_agent',
      content: {role: 'model', parts: [{text: 'the answer'}]},
      customMetadata:
        response === undefined ? undefined : {'a2a:response': response},
    });
  }

  it('promotes when the task status is not an object', () => {
    const event = peerEvent({status: 'completed', artifacts: []});

    expect(promoteResponseToOutput(event, 'peer_agent')).toBe(true);
    expect(event.output).toBe('the answer');
  });

  it('promotes when the response metadata is not an object', () => {
    const event = peerEvent('not a task');

    expect(promoteResponseToOutput(event, 'peer_agent')).toBe(true);
  });

  it('promotes when the task state is not a string', () => {
    const event = peerEvent({status: {state: 42}});

    expect(promoteResponseToOutput(event, 'peer_agent')).toBe(true);
  });

  it('skips a state the peer reports as still in progress', () => {
    const event = peerEvent({status: {state: 'working'}});

    expect(promoteResponseToOutput(event, 'peer_agent')).toBe(false);
    expect(event.output).toBeUndefined();
  });

  it('promotes nothing from an event whose content has no parts', () => {
    const event = createEvent({author: 'peer_agent', content: {role: 'model'}});

    expect(promoteResponseToOutput(event, 'peer_agent')).toBe(false);
    expect(event.output).toBeUndefined();
  });
});
