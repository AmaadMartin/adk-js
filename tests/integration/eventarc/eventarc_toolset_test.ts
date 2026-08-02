/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {protos} from '@google-cloud/eventarc-publishing';
import {
  AgentProvided,
  Event,
  EventarcToolset,
  LlmAgent,
  OMIT,
} from '@google/adk';
import {afterEach, describe, expect, it, vi} from 'vitest';
import {z} from 'zod';

import {
  createRunner,
  GeminiWithMockResponses,
  RawGenerateContentResponse,
} from '../test_case_utils.js';

type PublishRequest =
  protos.google.cloud.eventarc.publishing.v1.IPublishRequest;

const mocks = vi.hoisted(() => ({
  publish:
    vi.fn<
      (request: PublishRequest, options: {timeout?: number}) => Promise<void>
    >(),
  close: vi.fn<() => Promise<void>>(),
}));

vi.mock('@google-cloud/eventarc-publishing', () => ({
  PublisherClient: class {
    publish = mocks.publish;
    close = mocks.close;
  },
}));

const ORDERS_BUS =
  'projects/test-project/locations/us-central1/messageBuses/orders';

const ORDER_PAYLOAD = z.object({
  userId: z.string(),
  action: z.string(),
});

interface OrderPayload {
  userId: string;
  action: string;
}

function publishedAttributes(request: PublishRequest): Record<string, string> {
  const attributes: Record<string, string> = {};
  for (const [key, value] of Object.entries(
    request.protoMessage?.attributes ?? {},
  )) {
    if (typeof value.ceString === 'string') {
      attributes[key] = value.ceString;
    }
  }
  return attributes;
}

describe('EventarcToolset in an LlmAgent', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('publishes the CloudEvent a domain-specific tool call resolves to', async () => {
    const toolset = new EventarcToolset({
      toolConfig: {projectId: 'test-project', publishTimeoutMs: 20_000},
    });
    toolset.createPublishTool<OrderPayload>({
      name: 'publish_order_event',
      description: 'Publishes an order lifecycle event to the orders bus.',
      bus: ORDERS_BUS,
      ceAttributesBinding: {
        type: (payload) => `com.example.order.${payload.action}`,
        source: '//my-app/order-service',
        subject: AgentProvided({description: 'The order subject.'}),
        time: OMIT,
        customAttributes: {region: 'europe', trace: OMIT},
      },
      payloadSchema: ORDER_PAYLOAD,
    });

    const responses: RawGenerateContentResponse[] = [
      {
        candidates: [
          {
            content: {
              role: 'model',
              parts: [
                {
                  functionCall: {
                    name: 'publish_order_event',
                    args: {
                      subject: 'orders/42',
                      event_data: {userId: 'user-1', action: 'created'},
                    },
                  },
                },
              ],
            },
          },
        ],
      },
      {
        candidates: [
          {
            content: {role: 'model', parts: [{text: 'Order event published.'}]},
          },
        ],
      },
    ];

    const agent = new LlmAgent({
      model: new GeminiWithMockResponses(responses),
      name: 'orders_agent',
      description: 'Publishes order events.',
      instruction: 'Publish order lifecycle events when asked.',
      tools: [toolset],
    });

    const {run} = await createRunner(agent);
    const events: Event[] = [];
    for await (const event of run('Publish the created event for user-1')) {
      events.push(event);
    }

    expect(mocks.publish).toHaveBeenCalledOnce();
    const [request, callOptions] = mocks.publish.mock.calls[0];
    expect(request.messageBus).toBe(ORDERS_BUS);
    expect(request.protoMessage).toMatchObject({
      type: 'com.example.order.created',
      source: '//my-app/order-service',
      specVersion: '1.0',
      textData: JSON.stringify({userId: 'user-1', action: 'created'}),
    });
    // `time: OMIT` removes the attribute from the publish call, which is where
    // adk-python stops too: `publishMessage` then stamps the current time.
    // OMIT genuinely drops an attribute that has no default, such as `trace`.
    expect(publishedAttributes(request)).toEqual({
      datacontenttype: 'application/json',
      subject: 'orders/42',
      region: 'europe',
      time: expect.stringMatching(
        /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/,
      ),
    });
    expect(callOptions).toEqual({timeout: 20_000});

    const functionResponse = events
      .flatMap((event) => event.content?.parts ?? [])
      .find((part) => part.functionResponse)?.functionResponse;
    expect(functionResponse?.response).toMatchObject({status: 'SUCCESS'});
    expect(events.at(-1)?.content?.parts?.[0]?.text).toBe(
      'Order event published.',
    );

    await toolset.close();
    expect(mocks.close).toHaveBeenCalledOnce();
  });

  it('reports a publish failure to the model instead of throwing', async () => {
    mocks.publish.mockRejectedValueOnce(new Error('bus not found'));

    const toolset = new EventarcToolset({
      toolConfig: {projectId: 'test-project'},
    });

    const responses: RawGenerateContentResponse[] = [
      {
        candidates: [
          {
            content: {
              role: 'model',
              parts: [
                {
                  functionCall: {
                    name: 'publish_message',
                    args: {
                      bus: 'projects/test-project/locations/us-central1/messageBuses/missing',
                      type: 'com.example.order.created',
                      source: '//my-app/order-service',
                    },
                  },
                },
              ],
            },
          },
        ],
      },
      {
        candidates: [
          {
            content: {role: 'model', parts: [{text: 'Publishing failed.'}]},
          },
        ],
      },
    ];

    const agent = new LlmAgent({
      model: new GeminiWithMockResponses(responses),
      name: 'orders_agent',
      description: 'Publishes order events.',
      instruction: 'Publish order lifecycle events when asked.',
      tools: [toolset],
    });

    const {run} = await createRunner(agent);
    const events: Event[] = [];
    for await (const event of run('Publish to a bus that does not exist')) {
      events.push(event);
    }

    const functionResponse = events
      .flatMap((event) => event.content?.parts ?? [])
      .find((part) => part.functionResponse)?.functionResponse;
    expect(functionResponse?.response).toEqual({
      status: 'ERROR',
      error_details: 'bus not found',
    });

    await toolset.close();
  });
});
