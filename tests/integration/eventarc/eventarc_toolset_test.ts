/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Drives {@link EventarcToolset} through a whole agent turn, so the path from
 * a model's function call to the publish request is exercised end to end.
 *
 * The publishing SDK is replaced by an in-process fake, and the model by a
 * scripted one, so the test needs no network and no credentials.
 */

import {
  BaseLlm,
  BaseLlmConnection,
  cleanupClients,
  Event,
  EventarcToolset,
  InMemoryRunner,
  LlmAgent,
  LlmRequest,
  LlmResponse,
} from '@google/adk';
import {createUserContent} from '@google/genai';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import type {
  PublisherClientOptions,
  PublishRequest,
} from '../../../core/src/integrations/eventarc/sdk.js';

const BUS = 'projects/test-project/locations/us-central1/messageBuses/my-bus';

const {publishedRequests, clientOptions} = vi.hoisted(() => ({
  publishedRequests: [] as PublishRequest[],
  clientOptions: [] as Array<PublisherClientOptions | undefined>,
}));

vi.mock('@google-cloud/eventarc-publishing', () => {
  class FakePublisherClient {
    constructor(options?: PublisherClientOptions) {
      clientOptions.push(options);
    }

    async publish(request: PublishRequest): Promise<unknown> {
      publishedRequests.push(request);
      return [{}, undefined, undefined];
    }

    async close(): Promise<void> {}
  }
  return {PublisherClient: FakePublisherClient};
});

/** A model that replays a fixed script, so a turn's tool calls are exact. */
class ScriptedLlm extends BaseLlm {
  private index = 0;

  constructor(private readonly script: LlmResponse[]) {
    super({model: 'scripted-llm'});
  }

  async *generateContentAsync(
    _request: LlmRequest,
  ): AsyncGenerator<LlmResponse, void, void> {
    yield this.script[this.index++] ?? {
      content: {role: 'model', parts: [{text: 'published'}]},
    };
  }

  async connect(_request: LlmRequest): Promise<BaseLlmConnection> {
    throw new Error('Live connections are not used in this test.');
  }
}

/** The model turn that calls `publish_message` with a full CloudEvent. */
function callPublishMessage(): LlmResponse {
  return {
    content: {
      role: 'model',
      parts: [
        {
          functionCall: {
            id: 'call-1',
            name: 'publish_message',
            args: {
              bus: BUS,
              type: 'com.example.order.created',
              source: '//orders/service',
              id: 'event-1',
              data: {orderId: 'A-1'},
              subject: 'orders/A-1',
              time: '2026-06-03T12:00:00Z',
              custom_attributes: {region: 'useast1'},
            },
          },
        },
      ],
    },
  };
}

/** Runs one user turn against an agent holding the Eventarc toolset. */
async function runTurn(toolset: EventarcToolset): Promise<Event[]> {
  const agent = new LlmAgent({
    name: 'event_publisher',
    model: new ScriptedLlm([callPublishMessage()]),
    tools: [toolset],
  });
  const runner = new InMemoryRunner({agent, appName: 'eventarc_integration'});
  const session = await runner.sessionService.createSession({
    appName: 'eventarc_integration',
    userId: 'user',
  });

  const events: Event[] = [];
  for await (const event of runner.runAsync({
    userId: 'user',
    sessionId: session.id,
    newMessage: createUserContent('publish the order event'),
  })) {
    events.push(event);
  }
  return events;
}

/** The function responses carried by a turn's events. */
function functionResponses(events: Event[]): unknown[] {
  return events
    .flatMap((event) => event.content?.parts ?? [])
    .flatMap((part) => (part.functionResponse ? [part.functionResponse] : []))
    .map((response) => response.response);
}

describe('EventarcToolset in an agent turn', () => {
  beforeEach(async () => {
    await cleanupClients();
    publishedRequests.length = 0;
    clientOptions.length = 0;
  });

  afterEach(async () => {
    await cleanupClients();
  });

  it('publishes the CloudEvent the model asked for', async () => {
    const toolset = new EventarcToolset({
      toolConfig: {projectId: 'test-project'},
    });

    const events = await runTurn(toolset);

    expect(functionResponses(events)).toEqual([
      {status: 'SUCCESS', message_id: 'event-1'},
    ]);
    expect(publishedRequests).toHaveLength(1);
    const [request] = publishedRequests;
    expect(request.messageBus).toBe(BUS);
    expect(request.protoMessage).toMatchObject({
      id: 'event-1',
      source: '//orders/service',
      type: 'com.example.order.created',
      specVersion: '1.0',
      textData: '{"orderId":"A-1"}',
    });
    expect(request.protoMessage?.attributes).toMatchObject({
      datacontenttype: {ceString: 'application/json'},
      region: {ceString: 'useast1'},
      subject: {ceString: 'orders/A-1'},
      time: {ceString: '2026-06-03T12:00:00Z'},
    });
    expect(clientOptions[0]?.projectId).toBe('test-project');
  });

  it('closes the publisher client when the toolset closes', async () => {
    const toolset = new EventarcToolset({
      toolConfig: {projectId: 'test-project'},
    });
    await runTurn(toolset);

    await toolset.close();

    // A closed cache reconnects, which is what a second publish proves.
    await runTurn(toolset);
    expect(clientOptions).toHaveLength(2);
  });
});
