/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Beyond adk-python's suite. Python gets both conversions from its client
 * library: `bytes.decode` raises on invalid UTF-8, and `publish_time` already
 * arrives as a datetime. The JS client does neither, so the port has to, and
 * the two conversions need their own tests.
 */

import {describe, expect, it} from 'vitest';
import {
  decodeMessageData,
  formatPublishTime,
  toPulledMessage,
} from '../../../src/tools/pubsub/message_codec.js';

describe('decodeMessageData', () => {
  it('reads a UTF-8 body as text', () => {
    const data = new TextEncoder().encode('Hello, wörld');

    expect(decodeMessageData(data)).toBe('Hello, wörld');
  });

  it('reports a body that is not valid UTF-8 as base64', () => {
    const data = new Uint8Array([0xff, 0xfe, 0xfd]);

    expect(decodeMessageData(data)).toBe('//79');
  });

  it('keeps a body the client already decoded to a string', () => {
    expect(decodeMessageData('already text')).toBe('already text');
  });

  it.each([
    {label: 'null', data: null},
    {label: 'undefined', data: undefined},
  ])('reports a $label body as the empty string', ({data}) => {
    expect(decodeMessageData(data)).toBe('');
  });
});

describe('formatPublishTime', () => {
  it('formats whole seconds without a fraction', () => {
    expect(formatPublishTime({seconds: 1672531200, nanos: 0})).toBe(
      '2023-01-01T00:00:00Z',
    );
  });

  it('formats a fraction to nanosecond precision', () => {
    expect(formatPublishTime({seconds: 1672531200, nanos: 123456789})).toBe(
      '2023-01-01T00:00:00.123456789Z',
    );
  });

  it('pads a fraction shorter than nine digits', () => {
    expect(formatPublishTime({seconds: 1672531200, nanos: 5})).toBe(
      '2023-01-01T00:00:00.000000005Z',
    );
  });

  it('reads seconds that arrived as a string', () => {
    expect(formatPublishTime({seconds: '1672531200'})).toBe(
      '2023-01-01T00:00:00Z',
    );
  });

  it('treats an absent seconds field as the epoch', () => {
    expect(formatPublishTime({})).toBe('1970-01-01T00:00:00Z');
  });

  it.each([
    {label: 'null', timestamp: null},
    {label: 'undefined', timestamp: undefined},
  ])('reports $label as the empty string', ({timestamp}) => {
    expect(formatPublishTime(timestamp)).toBe('');
  });
});

describe('toPulledMessage', () => {
  it('reports every field of a complete message', () => {
    const pulled = toPulledMessage({
      ackId: 'ack_123',
      message: {
        messageId: '123',
        data: new TextEncoder().encode('Hello'),
        attributes: {key: 'value'},
        orderingKey: 'ABC',
        publishTime: {seconds: 1672531200, nanos: 0},
      },
    });

    expect(pulled).toEqual({
      message_id: '123',
      data: 'Hello',
      attributes: {key: 'value'},
      ordering_key: 'ABC',
      publish_time: '2023-01-01T00:00:00Z',
      ack_id: 'ack_123',
    });
  });

  it('falls back to empty values for a message with nothing set', () => {
    expect(toPulledMessage({})).toEqual({
      message_id: '',
      data: '',
      attributes: {},
      ordering_key: '',
      publish_time: '',
      ack_id: '',
    });
  });

  it('falls back to empty values for null fields', () => {
    const pulled = toPulledMessage({
      ackId: null,
      message: {
        messageId: null,
        data: null,
        attributes: null,
        orderingKey: null,
        publishTime: null,
      },
    });

    expect(pulled).toEqual({
      message_id: '',
      data: '',
      attributes: {},
      ordering_key: '',
      publish_time: '',
      ack_id: '',
    });
  });
});
