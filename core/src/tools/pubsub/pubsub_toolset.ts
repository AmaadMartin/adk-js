/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type {v1} from '@google-cloud/pubsub';
import {z} from 'zod';

import {ReadonlyContext} from '../../agents/readonly_context.js';
import {BaseTool} from '../base_tool.js';
import {BaseToolset, ToolPredicate} from '../base_toolset.js';
import {FunctionTool} from '../function_tool.js';
import {createClientOptions} from './client.js';
import {PubSubCredentialsConfig} from './config.js';
import {
  acknowledgeMessages,
  publishMessage,
  pullMessages,
} from './message_tool.js';

const publishMessageParameters = z.object({
  topicName: z
    .string()
    .describe(
      'The Pub/Sub topic name (e.g. projects/my-project/topics/my-topic).',
    ),
  message: z.string().describe('The message content to publish.'),
  attributes: z
    .record(z.string(), z.string())
    .optional()
    .describe('Attributes to attach to the message.'),
  orderingKey: z.string().optional().describe('Ordering key for the message.'),
});

const pullMessagesParameters = z.object({
  subscriptionName: z
    .string()
    .describe(
      'The Pub/Sub subscription name (e.g. projects/my-project/subscriptions/my-sub).',
    ),
  maxMessages: z
    .number()
    .int()
    .positive()
    .optional()
    .describe('The maximum number of messages to pull. Defaults to 1.'),
  autoAck: z
    .boolean()
    .optional()
    .describe(
      'Whether to automatically acknowledge the messages. Defaults to false.',
    ),
});

const acknowledgeMessagesParameters = z.object({
  subscriptionName: z
    .string()
    .describe(
      'The Pub/Sub subscription name (e.g. projects/my-project/subscriptions/my-sub).',
    ),
  ackIds: z
    .array(z.string())
    .describe('List of acknowledgment IDs to acknowledge.'),
});

/**
 * Loads `@google-cloud/pubsub` on first use. The Pub/Sub gRPC stack costs
 * hundreds of milliseconds to import, so it is kept out of the module graph of
 * `@google/adk` until a Pub/Sub tool is actually invoked.
 */
async function createPublisherClient(
  credentialsConfig?: PubSubCredentialsConfig,
): Promise<v1.PublisherClient> {
  const {v1: pubsubV1} = await import('@google-cloud/pubsub');
  return new pubsubV1.PublisherClient(createClientOptions(credentialsConfig));
}

async function createSubscriberClient(
  credentialsConfig?: PubSubCredentialsConfig,
): Promise<v1.SubscriberClient> {
  const {v1: pubsubV1} = await import('@google-cloud/pubsub');
  return new pubsubV1.SubscriberClient(createClientOptions(credentialsConfig));
}

/**
 * Pub/Sub Toolset contains tools for interacting with Pub/Sub topics and
 * subscriptions.
 *
 * The toolset exposes three tools:
 * - `publish_message`: publishes a message to a topic and returns its
 *   `messageId`.
 * - `pull_messages`: pulls up to `maxMessages` messages from a subscription,
 *   optionally acknowledging them, and returns them as {@link PulledMessage}s.
 * - `acknowledge_messages`: acknowledges previously pulled messages by ack ID.
 *
 * Each tool returns `{status: 'ERROR', error_details}` instead of throwing when
 * the Pub/Sub API call fails, so the model can report or retry.
 */
export class PubSubToolset extends BaseToolset {
  private readonly credentialsConfig?: PubSubCredentialsConfig;
  private publisherClient?: Promise<v1.PublisherClient>;
  private subscriberClient?: Promise<v1.SubscriberClient>;

  constructor(options?: {
    toolFilter?: ToolPredicate | string[];
    credentialsConfig?: PubSubCredentialsConfig;
  }) {
    super(options?.toolFilter || []);
    this.credentialsConfig = options?.credentialsConfig;
  }

  private getPublisherClient(): Promise<v1.PublisherClient> {
    this.publisherClient ??= createPublisherClient(this.credentialsConfig);
    return this.publisherClient;
  }

  private getSubscriberClient(): Promise<v1.SubscriberClient> {
    this.subscriberClient ??= createSubscriberClient(this.credentialsConfig);
    return this.subscriberClient;
  }

  /**
   * Get tools from the toolset.
   */
  override async getTools(
    readonlyContext?: ReadonlyContext,
  ): Promise<BaseTool[]> {
    const allTools: BaseTool[] = [
      new FunctionTool({
        name: 'publish_message',
        description: 'Publish a message to a Pub/Sub topic.',
        parameters: publishMessageParameters,
        execute: async (input) =>
          publishMessage(
            await this.getPublisherClient(),
            input.topicName,
            input.message,
            input.attributes,
            input.orderingKey,
          ),
      }),
      new FunctionTool({
        name: 'pull_messages',
        description: 'Pull messages from a Pub/Sub subscription.',
        parameters: pullMessagesParameters,
        execute: async (input) =>
          pullMessages(
            await this.getSubscriberClient(),
            input.subscriptionName,
            input.maxMessages,
            input.autoAck,
          ),
      }),
      new FunctionTool({
        name: 'acknowledge_messages',
        description: 'Acknowledge messages on a Pub/Sub subscription.',
        parameters: acknowledgeMessagesParameters,
        execute: async (input) =>
          acknowledgeMessages(
            await this.getSubscriberClient(),
            input.subscriptionName,
            input.ackIds,
          ),
      }),
    ];

    return allTools.filter((tool) =>
      this.isToolSelected(tool, readonlyContext),
    );
  }

  /**
   * Clean up resources used by the toolset.
   */
  override async close(): Promise<void> {
    const pending = [this.publisherClient, this.subscriberClient].filter(
      (client) => client !== undefined,
    );
    const clients = await Promise.all(pending);
    await Promise.all(clients.map((client) => client.close()));
  }
}
