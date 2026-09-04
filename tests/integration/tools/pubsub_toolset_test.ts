/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Drives the Pub/Sub tools through a real agent turn: the runner, the agent,
 * the session service and the toolset are the real ones. Only the model and
 * `@google-cloud/pubsub` are doubles, so no project and no network are needed.
 */

import {
  BaseLlm,
  BaseLlmConnection,
  Event,
  LlmAgent,
  LlmRequest,
  LlmResponse,
} from '@google/adk';
import {PubSubCredentialsConfig, PubSubToolset} from '@google/adk/tools/pubsub';
import {OAuth2Client} from 'google-auth-library';
import {beforeEach, describe, expect, it, vi} from 'vitest';
import {createRunner} from '../test_case_utils.js';

const TOPIC = 'projects/test-project/topics/orders';
const SUBSCRIPTION = 'projects/test-project/subscriptions/orders-sub';

/** One identity for every end user, the simplest valid configuration. */
function credentialsConfig(): PubSubCredentialsConfig {
  return {authClient: new OAuth2Client()};
}

/**
 * A double for `@google-cloud/pubsub` holding only what the tools touch.
 *
 * The publisher keeps what it was handed, and the subscriber answers a pull
 * with it, so a turn that publishes and then pulls reads back the message it
 * sent rather than a fixture.
 */
const pubsub = vi.hoisted(() => {
  const published: Array<{data: Uint8Array; ackId: string}> = [];

  class FakePubSub {
    topic(name: string) {
      return {
        async publishMessage({data}: {data: Uint8Array}): Promise<string> {
          if (name !== TOPIC) {
            throw new Error(`Topic not found: ${name}`);
          }
          published.push({data, ackId: `ack-${published.length}`});
          return `msg-${published.length}`;
        },
      };
    }

    async close(): Promise<void> {}
  }

  class FakeSubscriberClient {
    async pull({subscription}: {subscription: string}) {
      if (subscription !== SUBSCRIPTION) {
        throw new Error(`Subscription not found: ${subscription}`);
      }
      return [
        {
          receivedMessages: published.map(({data, ackId}) => ({
            ackId,
            message: {
              messageId: ackId.replace('ack', 'msg'),
              data,
              attributes: {},
              orderingKey: '',
              publishTime: {seconds: 1672531200, nanos: 0},
            },
          })),
        },
      ];
    }

    async acknowledge(): Promise<void> {}

    async close(): Promise<void> {}
  }

  return {
    published,
    PubSub: FakePubSub,
    SubscriberClient: FakeSubscriberClient,
  };
});

vi.mock('@google-cloud/pubsub', () => ({
  PubSub: pubsub.PubSub,
  v1: {SubscriberClient: pubsub.SubscriberClient},
}));

/** Publishes one message, then pulls the subscription, then answers. */
class PublishThenPullLlm extends BaseLlm {
  constructor(private readonly message: string) {
    super({model: 'publish-then-pull-llm'});
  }

  async *generateContentAsync(
    request: LlmRequest,
  ): AsyncGenerator<LlmResponse, void, void> {
    const answered = (request.contents ?? []).flatMap((content) =>
      (content.parts ?? []).flatMap((part) =>
        part.functionResponse?.name ? [part.functionResponse.name] : [],
      ),
    );
    if (!answered.includes('publish_message')) {
      yield functionCall('publish_message', {
        topic_name: TOPIC,
        message: this.message,
      });
      return;
    }
    if (!answered.includes('pull_messages')) {
      yield functionCall('pull_messages', {
        subscription_name: SUBSCRIPTION,
      });
      return;
    }
    yield {content: {role: 'model', parts: [{text: 'done'}]}};
  }

  async connect(_llmRequest: LlmRequest): Promise<BaseLlmConnection> {
    throw new Error('Method not implemented.');
  }
}

/** One tool call, as the model emits it. */
function functionCall(
  name: string,
  args: Record<string, unknown>,
): LlmResponse {
  return {content: {role: 'model', parts: [{functionCall: {name, args}}]}};
}

/** Records the request the agent builds, so the tool wiring can be asserted. */
class CapturingLlm extends BaseLlm {
  lastRequest?: LlmRequest;

  constructor() {
    super({model: 'capturing-llm'});
  }

  async *generateContentAsync(
    request: LlmRequest,
  ): AsyncGenerator<LlmResponse, void, void> {
    this.lastRequest = request;
    yield {content: {role: 'model', parts: [{text: 'done'}]}};
  }

  async connect(_llmRequest: LlmRequest): Promise<BaseLlmConnection> {
    throw new Error('Method not implemented.');
  }
}

/** Builds an agent holding one Pub/Sub toolset. */
function makeAgent(model: BaseLlm, toolset: PubSubToolset): LlmAgent {
  return new LlmAgent({
    model,
    name: 'pubsub_agent',
    description: 'Agent with the Pub/Sub toolset',
    instruction: 'Publish events and read the subscription.',
    tools: [toolset],
  });
}

/** Every tool response one run produced, keyed by tool name. */
async function toolResponses(
  run: (prompt: string) => AsyncGenerator<Event, void, undefined>,
  prompt: string,
): Promise<Record<string, unknown>> {
  const responses: Record<string, unknown> = {};
  for await (const event of run(prompt)) {
    for (const part of event.content?.parts ?? []) {
      const response = part.functionResponse;
      if (response?.name) {
        responses[response.name] = response.response;
      }
    }
  }
  return responses;
}

beforeEach(() => {
  pubsub.published.length = 0;
});

describe('PubSubToolset in an LlmAgent', () => {
  it('offers the three tools to the model', async () => {
    // No Pub/Sub client is needed to advertise the tools: the peer dependency
    // is loaded on the first tool call.
    const model = new CapturingLlm();
    const {run} = await createRunner(
      makeAgent(
        model,
        new PubSubToolset({credentialsConfig: credentialsConfig()}),
      ),
    );

    for await (const _event of run('What can you do?')) {
      // Drain the run so the request is fully built.
    }

    const declared =
      model.lastRequest?.config?.tools
        ?.flatMap((tool) => ('functionDeclarations' in tool ? tool : []))
        .flatMap((tool) => tool.functionDeclarations ?? []) ?? [];
    expect(declared.map((tool) => tool.name)).toEqual([
      'publish_message',
      'pull_messages',
      'acknowledge_messages',
    ]);
  });

  it('publishes a message and reads it back over two tool calls', async () => {
    const toolset = new PubSubToolset({
      credentialsConfig: credentialsConfig(),
      pubsubToolConfig: {projectId: 'test-project'},
    });
    const {run} = await createRunner(
      makeAgent(new PublishThenPullLlm('order 42 is ready'), toolset),
    );

    const responses = await toolResponses(
      run,
      'Announce that order 42 is ready',
    );

    expect(responses['publish_message']).toEqual({message_id: 'msg-1'});
    expect(responses['pull_messages']).toEqual({
      messages: [
        {
          message_id: 'msg-0',
          data: 'order 42 is ready',
          attributes: {},
          ordering_key: '',
          publish_time: '2023-01-01T00:00:00Z',
          ack_id: 'ack-0',
        },
      ],
    });
    await toolset.close();
  });

  it('reports an unknown topic to the model instead of throwing', async () => {
    const toolset = new PubSubToolset({credentialsConfig: credentialsConfig()});
    const {run} = await createRunner(
      makeAgent(new PublishThenPullLlm('order 42 is ready'), toolset),
    );
    vi.spyOn(pubsub.PubSub.prototype, 'topic').mockReturnValue({
      publishMessage: () => Promise.reject(new Error('Topic not found')),
    });

    const responses = await toolResponses(
      run,
      'Announce that order 42 is ready',
    );

    expect(responses['publish_message']).toEqual({
      status: 'ERROR',
      error_details: `Failed to publish message to topic '${TOPIC}': Topic not found`,
    });
    vi.restoreAllMocks();
    await toolset.close();
  });
});
