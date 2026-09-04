/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type {protos} from '@google-cloud/pubsub';

/** A published message, as the wire carries it. */
type ReceivedMessage = protos.google.pubsub.v1.IReceivedMessage;

/** A protobuf timestamp: whole seconds plus nanoseconds. */
type Timestamp = protos.google.protobuf.ITimestamp;

/**
 * One pulled message, as the model reads it.
 *
 * The keys are `snake_case` because they cross the model boundary and must
 * match what adk-python emits.
 */
export interface PulledMessage {
  message_id: string;
  data: string;
  attributes: Record<string, string>;
  ordering_key: string;
  publish_time: string;
  ack_id: string;
}

/** Rejects, rather than substitutes, a byte sequence that is not UTF-8. */
const utf8Decoder = new TextDecoder('utf-8', {fatal: true});

/** Nanoseconds in one second, the divisor a fractional part is padded to. */
const NANOSECOND_DIGITS = 9;

/** Strips the millisecond fraction `Date.toISOString` always writes. */
const MILLISECOND_FRACTION = /\.\d{3}Z$/;

/**
 * Decodes a message body as text, falling back to base64.
 *
 * A Pub/Sub message carries arbitrary bytes, and a model cannot read the
 * replacement characters that a lenient UTF-8 decode would produce. So a body
 * that is not valid UTF-8 is reported as base64 instead, which adk-python's
 * `_decode_message_data` also does.
 *
 * @param data The message body. The SDK reports it as a string when the
 *   response arrived as JSON, in which case it is already text.
 * @return The body as text, or its base64 encoding.
 */
export function decodeMessageData(
  data: Uint8Array | string | null | undefined,
): string {
  if (data === null || data === undefined) {
    return '';
  }
  if (typeof data === 'string') {
    return data;
  }
  try {
    return utf8Decoder.decode(data);
  } catch {
    return Buffer.from(data).toString('base64');
  }
}

/**
 * Formats a protobuf timestamp as RFC 3339, the format adk-python reports
 * through `publish_time.rfc3339()`.
 *
 * @param timestamp The timestamp, whose `seconds` field arrives as a number,
 *   a string or a `Long` depending on how the response was decoded.
 * @return The formatted timestamp, or the empty string when there is none.
 */
export function formatPublishTime(
  timestamp: Timestamp | null | undefined,
): string {
  if (!timestamp) {
    return '';
  }
  const seconds = Number(timestamp.seconds ?? 0);
  const nanos = timestamp.nanos ?? 0;
  const whole = new Date(seconds * 1000)
    .toISOString()
    .replace(MILLISECOND_FRACTION, '');
  if (nanos === 0) {
    return `${whole}Z`;
  }
  return `${whole}.${String(nanos).padStart(NANOSECOND_DIGITS, '0')}Z`;
}

/**
 * Converts one received message into the shape the model reads.
 *
 * Every field is optional on the wire, so each one falls back to an empty
 * value rather than reaching the model as `null`.
 *
 * @param received The message and its acknowledgement id.
 * @return The message as the `pull_messages` tool reports it.
 */
export function toPulledMessage(received: ReceivedMessage): PulledMessage {
  const message = received.message ?? {};
  return {
    message_id: message.messageId ?? '',
    data: decodeMessageData(message.data),
    attributes: message.attributes ?? {},
    ordering_key: message.orderingKey ?? '',
    publish_time: formatPublishTime(message.publishTime),
    ack_id: received.ackId ?? '',
  };
}
