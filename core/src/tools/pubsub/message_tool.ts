/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {getPublisherClient, getSubscriberClient} from './client.js';
import {PubSubCredentialsConfig, PubSubToolConfig} from './config.js';

function toRFC3339(timestamp?: {
  seconds?: number | string;
  nanos?: number | string;
}): string {
  if (!timestamp || !timestamp.seconds) {
    return new Date().toISOString();
  }
  const secs = Number(timestamp.seconds);
  const nanos = timestamp.nanos ? Number(timestamp.nanos) : 0;
  return new Date(secs * 1000 + nanos / 1000000).toISOString();
}

function decodeMessageData(data?: Uint8Array | string | null): string {
  if (!data) return '';
  const buffer = Buffer.isBuffer(data)
    ? data
    : data instanceof Uint8Array
      ? Buffer.from(data)
      : Buffer.from(data as string, 'base64');

  try {
    const utf8Str = buffer.toString('utf8');
    // Basic heuristics to check if the data wasn't successfully decoded as utf8:
    // If re-encoded utf8 matches the original buffer, it's valid utf8.
    if (Buffer.from(utf8Str, 'utf8').equals(buffer)) {
      return utf8Str;
    }
  } catch (_e) {
    // Fall back to base64 below
  }
  return buffer.toString('base64');
}

/**
 * Publish a message to a Pub/Sub topic.
 */
export async function publishMessage(
  topicName: string,
  message: string,
  credentialsConfig?: PubSubCredentialsConfig,
  settings?: PubSubToolConfig,
  attributes?: Record<string, string>,
  orderingKey?: string,
): Promise<{messageId?: string; status?: string; error_details?: string}> {
  try {
    const publisherClient = getPublisherClient(credentialsConfig);
    const messageBytes = Buffer.from(message, 'utf8');

    const [response] = await publisherClient.publish({
      topic: topicName,
      messages: [
        {
          data: messageBytes,
          attributes: attributes || {},
          orderingKey: orderingKey || '',
        },
      ],
    });

    if (response && response.messageIds && response.messageIds.length > 0) {
      return {messageId: response.messageIds[0]};
    }
    throw new Error('No message ID returned from publish');
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    return {
      status: 'ERROR',
      error_details: `Failed to publish message to topic '${topicName}': ${errorMessage}`,
    };
  }
}

/**
 * Pull messages from a Pub/Sub subscription.
 */
export async function pullMessages(
  subscriptionName: string,
  credentialsConfig?: PubSubCredentialsConfig,
  settings?: PubSubToolConfig,
  maxMessages = 1,
  autoAck = false,
): Promise<{
  messages?: Array<unknown>;
  status?: string;
  error_details?: string;
}> {
  try {
    const subscriberClient = getSubscriberClient(credentialsConfig);

    const [response] = await subscriberClient.pull({
      subscription: subscriptionName,
      maxMessages,
    });

    const messages = [];
    const ackIds = [];

    if (response.receivedMessages) {
      for (const receivedMessage of response.receivedMessages) {
        if (!receivedMessage.message) continue;
        const msg = receivedMessage.message;

        const messageData = decodeMessageData(msg.data);
        messages.push({
          messageId: msg.messageId,
          data: messageData,
          attributes: msg.attributes || {},
          orderingKey: msg.orderingKey || '',
          publishTime: toRFC3339(
            msg.publishTime as {
              seconds?: number | string;
              nanos?: number | string;
            },
          ),
          ackId: receivedMessage.ackId,
        });

        if (receivedMessage.ackId) {
          ackIds.push(receivedMessage.ackId);
        }
      }
    }

    if (autoAck && ackIds.length > 0) {
      await subscriberClient.acknowledge({
        subscription: subscriptionName,
        ackIds,
      });
    }

    return {messages};
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    return {
      status: 'ERROR',
      error_details: `Failed to pull messages from subscription '${subscriptionName}': ${errorMessage}`,
    };
  }
}

/**
 * Acknowledge messages on a Pub/Sub subscription.
 */
export async function acknowledgeMessages(
  subscriptionName: string,
  ackIds: string[],
  credentialsConfig?: PubSubCredentialsConfig,
  settings?: PubSubToolConfig, // eslint-disable-line @typescript-eslint/no-unused-vars
): Promise<{status?: string; error_details?: string}> {
  try {
    const subscriberClient = getSubscriberClient(credentialsConfig);

    await subscriberClient.acknowledge({
      subscription: subscriptionName,
      ackIds,
    });

    return {status: 'SUCCESS'};
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    return {
      status: 'ERROR',
      error_details: `Failed to acknowledge messages on subscription '${subscriptionName}': ${errorMessage}`,
    };
  }
}
