/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {v1} from '@google-cloud/pubsub';

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

  return buffer.toString('utf8');
}

/**
 * Publish a message to a Pub/Sub topic.
 */
export async function publishMessage(
  publisherClient: v1.PublisherClient,
  topicName: string,
  message: string,
  attributes?: Record<string, string>,
  orderingKey?: string,
): Promise<{messageId?: string; status?: string; error_details?: string}> {
  try {
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
  subscriberClient: v1.SubscriberClient,
  subscriptionName: string,
  maxMessages = 1,
  autoAck = false,
): Promise<{
  messages?: Array<unknown>;
  status?: string;
  error_details?: string;
}> {
  try {
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
  subscriberClient: v1.SubscriberClient,
  subscriptionName: string,
  ackIds: string[],
): Promise<{status?: string; error_details?: string}> {
  try {
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
