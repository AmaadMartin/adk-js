/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Type} from '@google/genai';
import {ReadonlyContext} from '../../agents/readonly_context.js';
import {BaseTool} from '../base_tool.js';
import {BaseToolset, ToolPredicate} from '../base_toolset.js';
import {FunctionTool} from '../function_tool.js';
import {cleanupClients} from './client.js';
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

  constructor(options?: {
    toolFilter?: ToolPredicate | string[];
    credentialsConfig?: PubSubCredentialsConfig;
    pubsubToolConfig?: PubSubToolConfig;
  }) {
    super(options?.toolFilter || []);
    this.credentialsConfig = options?.credentialsConfig;
    this.toolSettings = options?.pubsubToolConfig || {};
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
            input.topicName as string,
            input.message as string,
            this.credentialsConfig,
            this.toolSettings,
            input.attributes as Record<string, string>,
            input.orderingKey as string,
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
            input.subscriptionName as string,
            this.credentialsConfig,
            this.toolSettings,
            input.maxMessages as number,
            input.autoAck as boolean,
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
            input.subscriptionName as string,
            input.ackIds as string[],
            this.credentialsConfig,
            this.toolSettings,
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

    // `isToolSelected` from BaseToolset uses `readonlyContext` but since we passed an effective
    // default (empty array) `super(options?.toolFilter || [])`, the fallback might fail.
    // Wait, the base class checks if `this.toolFilter` is array and empty.

    // Create a dummy context if undefined for the predicate since `isToolSelected` requires one if `toolFilter` is a function.
    const ctx =
      readonlyContext || ({_id: 'dummy'} as unknown as ReadonlyContext);

    // Oh wait, `isToolSelected` is protected, we can just map and filter using it.
    // wait, JS allows accessing protected via `this.isToolSelected(tool, ctx)`
    return allTools.filter((tool) =>
      this.isToolSelected(tool as BaseTool, ctx as ReadonlyContext),
    );
  }

  /**
   * Clean up resources used by the toolset.
   */
  override async close(): Promise<void> {
    await cleanupClients();
  }
}
