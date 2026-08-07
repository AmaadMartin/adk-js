/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type {protos, v1} from '@google-cloud/pubsub';

const MILLIS_PER_SECOND = 1000;
const NANOS_PER_MILLI = 1_000_000;

/** The largest absolute value a JavaScript `Date` can represent, in millis. */
const MAX_DATE_MILLIS = 8.64e15;

/**
 * A message returned by {@link pullMessages}, flattened into JSON-friendly
 * values the model can consume directly.
 */
export interface PulledMessage {
  /** Server-assigned ID of the message. */
  messageId?: string;
  /** The message payload decoded as UTF-8 text. */
  data: string;
  /** Attributes attached to the message; empty when none were set. */
  attributes: Record<string, string>;
  /** Ordering key of the message; empty when the message is unordered. */
  orderingKey: string;
  /**
   * The publish time as an RFC 3339 string. Absent when the server did not
   * supply one — a missing publish time is reported as missing rather than
   * substituted with the current time.
   */
  publishTime?: string;
  /** The ack ID needed to acknowledge this message. */
  ackId?: string;
}

/** The result of {@link publishMessage}. */
export interface PublishMessageResult {
  messageId?: string;
  status?: string;
  error_details?: string;
}

/** The result of {@link pullMessages}. */
export interface PullMessagesResult {
  messages?: PulledMessage[];
  status?: string;
  error_details?: string;
}

/** The result of {@link acknowledgeMessages}. */
export interface AcknowledgeMessagesResult {
  status?: string;
  error_details?: string;
}

/**
 * Converts a protobuf timestamp into an RFC 3339 string.
 *
 * Returns `undefined` when the timestamp is absent or cannot be represented as
 * a `Date`, so callers omit the field rather than reporting a fabricated time.
 *
 * `seconds` is `number | Long | string` in the wire schema; `Number()` handles
 * all three (a `Long` stringifies to its decimal value), and the finiteness
 * checks keep a malformed value from reaching `new Date(NaN).toISOString()`,
 * which throws `RangeError`.
 */
function toRFC3339(
  timestamp?: protos.google.protobuf.ITimestamp | null,
): string | undefined {
  if (timestamp?.seconds === undefined || timestamp.seconds === null) {
    return undefined;
  }

  const seconds = Number(timestamp.seconds);
  const nanos = Number(timestamp.nanos ?? 0);
  if (!Number.isFinite(seconds) || !Number.isFinite(nanos)) {
    return undefined;
  }

  const millis = seconds * MILLIS_PER_SECOND + nanos / NANOS_PER_MILLI;
  if (!Number.isFinite(millis) || Math.abs(millis) > MAX_DATE_MILLIS) {
    return undefined;
  }

  return new Date(millis).toISOString();
}

function decodeMessageData(data?: Uint8Array | Buffer | string | null): string {
  if (!data) return '';
  const buffer = Buffer.isBuffer(data)
    ? data
    : data instanceof Uint8Array
      ? Buffer.from(data)
      : Buffer.from(data, 'base64');

  return buffer.toString('utf8');
}

function toPulledMessage(
  receivedMessage: protos.google.pubsub.v1.IReceivedMessage,
  message: protos.google.pubsub.v1.IPubsubMessage,
): PulledMessage {
  return {
    messageId: message.messageId ?? undefined,
    data: decodeMessageData(message.data),
    attributes: message.attributes ?? {},
    orderingKey: message.orderingKey ?? '',
    publishTime: toRFC3339(message.publishTime),
    ackId: receivedMessage.ackId ?? undefined,
  };
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
): Promise<PublishMessageResult> {
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
): Promise<PullMessagesResult> {
  try {
    const [response] = await subscriberClient.pull({
      subscription: subscriptionName,
      maxMessages,
    });

    const messages: PulledMessage[] = [];
    const ackIds: string[] = [];

    for (const receivedMessage of response.receivedMessages ?? []) {
      if (!receivedMessage.message) continue;

      messages.push(toPulledMessage(receivedMessage, receivedMessage.message));

      if (receivedMessage.ackId) {
        ackIds.push(receivedMessage.ackId);
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
): Promise<AcknowledgeMessagesResult> {
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
