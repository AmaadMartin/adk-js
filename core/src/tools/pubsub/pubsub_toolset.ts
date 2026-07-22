/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {v1} from '@google-cloud/pubsub';
import {Type} from '@google/genai';
import {ReadonlyContext} from '../../agents/readonly_context.js';
import {BaseTool} from '../base_tool.js';
import {BaseToolset, ToolPredicate} from '../base_toolset.js';
import {FunctionTool} from '../function_tool.js';
import {createClientOptions} from './client.js';
import {PubSubCredentialsConfig, PubSubToolConfig} from './config.js';
import {
  acknowledgeMessages,
  publishMessage,
  pullMessages,
} from './message_tool.js';

/**
 * Pub/Sub Toolset contains tools for interacting with Pub/Sub topics and subscriptions.
 */
export class PubSubToolset extends BaseToolset {
  private readonly credentialsConfig?: PubSubCredentialsConfig;
  private readonly toolSettings: PubSubToolConfig;
  private publisherClient?: v1.PublisherClient;
  private subscriberClient?: v1.SubscriberClient;

  constructor(options?: {
    toolFilter?: ToolPredicate | string[];
    credentialsConfig?: PubSubCredentialsConfig;
    pubsubToolConfig?: PubSubToolConfig;
  }) {
    super(options?.toolFilter || []);
    this.credentialsConfig = options?.credentialsConfig;
    this.toolSettings = options?.pubsubToolConfig || {};
  }

  private getPublisherClient(): v1.PublisherClient {
    if (!this.publisherClient) {
      this.publisherClient = new v1.PublisherClient(
        createClientOptions(this.credentialsConfig),
      );
    }
    return this.publisherClient;
  }

  private getSubscriberClient(): v1.SubscriberClient {
    if (!this.subscriberClient) {
      this.subscriberClient = new v1.SubscriberClient(
        createClientOptions(this.credentialsConfig),
      );
    }
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
        parameters: {
          type: Type.OBJECT,
          properties: {
            topicName: {
              type: Type.STRING,
              description:
                'The Pub/Sub topic name (e.g. projects/my-project/topics/my-topic).',
            },
            message: {
              type: Type.STRING,
              description: 'The message content to publish.',
            },
            attributes: {
              type: Type.OBJECT,
              additionalProperties: {type: Type.STRING},
              description: 'Attributes to attach to the message.',
            },
            orderingKey: {
              type: Type.STRING,
              description: 'Ordering key for the message.',
            },
          },
          required: ['topicName', 'message'],
        },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        execute: async (input: any) => {
          return publishMessage(
            this.getPublisherClient(),
            String(input.topicName),
            String(input.message),
            input.attributes as Record<string, string> | undefined,
            input.orderingKey ? String(input.orderingKey) : undefined,
          );
        },
      }),
      new FunctionTool({
        name: 'pull_messages',
        description: 'Pull messages from a Pub/Sub subscription.',
        parameters: {
          type: Type.OBJECT,
          properties: {
            subscriptionName: {
              type: Type.STRING,
              description:
                'The Pub/Sub subscription name (e.g. projects/my-project/subscriptions/my-sub).',
            },
            maxMessages: {
              type: Type.INTEGER,
              description:
                'The maximum number of messages to pull. Defaults to 1.',
            },
            autoAck: {
              type: Type.BOOLEAN,
              description:
                'Whether to automatically acknowledge the messages. Defaults to false.',
            },
          },
          required: ['subscriptionName'],
        },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        execute: async (input: any) => {
          return pullMessages(
            this.getSubscriberClient(),
            String(input.subscriptionName),
            input.maxMessages !== undefined
              ? Number(input.maxMessages)
              : undefined,
            input.autoAck !== undefined ? Boolean(input.autoAck) : undefined,
          );
        },
      }),
      new FunctionTool({
        name: 'acknowledge_messages',
        description: 'Acknowledge messages on a Pub/Sub subscription.',
        parameters: {
          type: Type.OBJECT,
          properties: {
            subscriptionName: {
              type: Type.STRING,
              description:
                'The Pub/Sub subscription name (e.g. projects/my-project/subscriptions/my-sub).',
            },
            ackIds: {
              type: Type.ARRAY,
              items: {type: Type.STRING},
              description: 'List of acknowledgment IDs to acknowledge.',
            },
          },
          required: ['subscriptionName', 'ackIds'],
        },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        execute: async (input: any) => {
          return acknowledgeMessages(
            this.getSubscriberClient(),
            String(input.subscriptionName),
            input.ackIds as string[],
          );
        },
      }),
    ];

    if (
      !this.toolFilter ||
      (Array.isArray(this.toolFilter) && this.toolFilter.length === 0)
    ) {
      return allTools;
    }

    return allTools.filter((tool) =>
      this.isToolSelected(tool as BaseTool, readonlyContext),
    );
  }

  /**
   * Clean up resources used by the toolset.
   */
  override async close(): Promise<void> {
    const closures: Array<Promise<void>> = [];
    if (this.publisherClient) {
      closures.push(this.publisherClient.close());
    }
    if (this.subscriberClient) {
      closures.push(this.subscriberClient.close());
    }
    await Promise.all(closures);
  }
}
