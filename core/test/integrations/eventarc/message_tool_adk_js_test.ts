/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Payload and tracing cases adk-python's test file does not cover, kept apart
 * from the ported set in `message_tool_test.ts`.
 */

import {cleanupClients, EventarcPublishStatus} from '@google/adk';
import {propagation} from '@opentelemetry/api';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {
  errorDetails,
  eventAttributes,
  onlyEvent,
  publish,
  resetEventarcFake,
  StubPropagator,
} from './eventarc_test_utils.js';

vi.mock('@google-cloud/eventarc-publishing', async () => {
  const {FakePublisherClient} = await import('./eventarc_test_utils.js');
  return {PublisherClient: FakePublisherClient};
});

describe('publishMessage payloads', () => {
  beforeEach(async () => {
    await cleanupClients();
    resetEventarcFake();
  });

  afterEach(async () => {
    await cleanupClients();
    propagation.disable();
  });

  it('sends a string payload declared as JSON unchanged', async () => {
    const res = await publish({
      data: '{"already":"json"}',
      datacontenttype: 'application/json',
    });

    expect(res.status).toBe(EventarcPublishStatus.SUCCESS);
    expect(onlyEvent().textData).toBe('{"already":"json"}');
  });

  it('reports a payload with no JSON representation', async () => {
    const res = await publish({data: () => 'not serializable'});

    expect(errorDetails(res)).toContain('Failed to serialize data to JSON');
  });

  it('renders a non-JSON payload with String', async () => {
    const res = await publish({data: 42, datacontenttype: 'text/plain'});

    expect(res.status).toBe(EventarcPublishStatus.SUCCESS);
    expect(onlyEvent().textData).toBe('42');
  });

  it('reports a cyclic payload under a non-JSON content type', async () => {
    const circular: Record<string, unknown> = {};
    circular['self'] = circular;

    const res = await publish({
      data: circular,
      datacontenttype: 'application/xml',
    });

    expect(errorDetails(res)).toContain('Failed to serialize data');
  });

  it('keeps an explicit content type on an event with no payload', async () => {
    const res = await publish({datacontenttype: 'application/xml'});

    expect(res.status).toBe(EventarcPublishStatus.SUCCESS);
    const event = onlyEvent();
    expect(event.textData).toBeUndefined();
    expect(eventAttributes(event)['datacontenttype']).toBe('application/xml');
  });

  it('rejects a digits-only custom attribute key, as adk-python does', async () => {
    const res = await publish({custom_attributes: {'123': 'val'}});

    expect(errorDetails(res)).toContain('Invalid custom attribute key: 123');
  });

  it('accepts a custom attribute key of letters and digits', async () => {
    const res = await publish({custom_attributes: {a1: 'val'}});

    expect(res.status).toBe(EventarcPublishStatus.SUCCESS);
    expect(eventAttributes(onlyEvent())['a1']).toBe('val');
  });
});

describe('publishMessage validation stricter than adk-python', () => {
  beforeEach(async () => {
    await cleanupClients();
    resetEventarcFake();
  });

  afterEach(async () => {
    await cleanupClients();
  });

  it('rejects base64 holding characters outside the alphabet', async () => {
    const res = await publish({data: 'aGVsbG8h!!', is_base64_encoded: true});

    expect(errorDetails(res)).toContain('Invalid base64 string');
  });

  it('rejects a custom attribute key outside ASCII', async () => {
    const res = await publish({custom_attributes: {café: 'val'}});

    expect(errorDetails(res)).toContain(
      'Invalid custom attribute key: caf\u00e9',
    );
  });

  it('rejects a date with no time of day', async () => {
    const res = await publish({time: '2026-01-01'});

    expect(errorDetails(res)).toContain('Invalid RFC 3339 time format');
  });
});

describe('publishMessage tracing', () => {
  beforeEach(async () => {
    await cleanupClients();
    resetEventarcFake();
  });

  afterEach(async () => {
    await cleanupClients();
    // The OpenTelemetry API refuses a second global registration, so a test
    // that installed a propagator has to withdraw it.
    propagation.disable();
  });

  it('leaves out the trace attributes when tracing is not requested', async () => {
    propagation.setGlobalPropagator(new StubPropagator());

    const res = await publish();

    expect(res.status).toBe(EventarcPublishStatus.SUCCESS);
    expect(eventAttributes(onlyEvent())).not.toHaveProperty('traceparent');
  });

  it('carries only the trace keys the propagator writes', async () => {
    propagation.setGlobalPropagator(new StubPropagator(['traceparent']));

    const res = await publish({include_tracing_extension: true});

    expect(res.status).toBe(EventarcPublishStatus.SUCCESS);
    const attributes = eventAttributes(onlyEvent());
    expect(attributes['traceparent']).toBe('00-testtrace-testid-01');
    expect(attributes).not.toHaveProperty('tracestate');
  });
});
