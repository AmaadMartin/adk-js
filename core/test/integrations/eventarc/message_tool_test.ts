/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Ported from adk-python
 * `tests/unittests/integrations/eventarc/test_message_tool.py`, read at
 * `a3bd1115` on `main`. Each `it` keeps its Python name.
 */

import {
  cleanupClients,
  EventarcPublishStatus,
  publishMessage,
} from '@google/adk';
import {propagation} from '@opentelemetry/api';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {
  builtClients,
  BUS,
  errorDetails,
  eventAttributes,
  onlyEvent,
  onlyPublish,
  publish,
  publishBehavior,
  resetEventarcFake,
  SETTINGS,
  StubPropagator,
} from './eventarc_test_utils.js';

vi.mock('@google-cloud/eventarc-publishing', async () => {
  const {FakePublisherClient} = await import('./eventarc_test_utils.js');
  return {PublisherClient: FakePublisherClient};
});

const UUID_V4_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe('publishMessage', () => {
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

  it('test_publish_message_success_text', async () => {
    const res = await publish({data: 'hello world'});

    expect(res.status).toBe(EventarcPublishStatus.SUCCESS);
    expect(res).toHaveProperty('message_id');
    expect(builtClients).toHaveLength(1);
    expect(builtClients[0].options?.projectId).toBe('test-project');
  });

  it('test_publish_message_custom_timeout', async () => {
    const res = await publishMessage(
      {
        bus: BUS,
        type: 'com.example.test',
        source: '//test/source',
        data: 'hello world',
      },
      {toolConfig: {projectId: 'test-project', publishTimeoutMs: 30_000}},
    );

    expect(res.status).toBe(EventarcPublishStatus.SUCCESS);
    expect(onlyPublish().options?.timeout).toBe(30_000);
  });

  it('test_publish_message_success_json', async () => {
    const res = await publish({data: {foo: 'bar'}});

    expect(res.status).toBe(EventarcPublishStatus.SUCCESS);
  });

  it('test_publish_message_base64_encoded', async () => {
    const encoded = Buffer.from('binary data').toString('base64');

    const res = await publish({data: encoded, is_base64_encoded: true});

    expect(res.status).toBe(EventarcPublishStatus.SUCCESS);
    expect(onlyEvent().binaryData).toEqual(
      new Uint8Array(Buffer.from('binary data')),
    );
  });

  it('test_publish_message_invalid_base64', async () => {
    const res = await publish({
      data: 'not-base64-!@#',
      is_base64_encoded: true,
    });

    expect(errorDetails(res)).toContain('Invalid base64');
  });

  it('test_publish_message_unserializable_json', async () => {
    const circular: Record<string, unknown> = {};
    circular['self'] = circular;

    const res = await publish({data: {foo: circular}});

    expect(errorDetails(res)).toContain('Failed to serialize data');
  });

  it.each([
    {
      name: 'invalid_type',
      input: {type: ''},
      error: 'type must be a non-empty string',
    },
    {
      name: 'invalid_source',
      input: {source: ''},
      error: 'source must be a non-empty string',
    },
    {
      name: 'invalid_id',
      input: {id: '   '},
      error: 'id, if provided, must be a non-empty string',
    },
    {
      name: 'invalid_base64_data_type',
      input: {data: 123, is_base64_encoded: true},
      error: 'data must be a string when is_base64_encoded is True',
    },
    {
      name: 'invalid_custom_attributes_type',
      input: {custom_attributes: 'not a dict'},
      error: 'custom_attributes must be a dict',
    },
    {
      name: 'invalid_custom_attributes_keys',
      input: {custom_attributes: {'InvalidKey!': 'val'}},
      error: 'Invalid custom attribute key',
    },
    {
      name: 'invalid_time_type',
      input: {time: 12345},
      error: 'time must be a string',
    },
    {
      name: 'invalid_time_format',
      input: {time: 'invalid-time'},
      error: 'Invalid RFC 3339',
    },
  ])('test_publish_message_invalid_inputs: $name', async ({input, error}) => {
    const res = await publishMessage(
      {bus: 'bus', type: 'type', source: 'source', ...input},
      {toolConfig: SETTINGS},
    );

    expect(errorDetails(res)).toContain(error);
    expect(builtClients).toHaveLength(0);
  });

  it.each([
    '2026-06-03T12:00:00Z',
    '2026-06-03T12:00:00.123456Z',
    '2026-06-03T12:00:00+00:00',
    '2026-06-03T12:00:00-07:00',
    '2026-06-03T12:00:00.123+02:00',
  ])('test_publish_message_time_valid_rfc3339: %s', async (time) => {
    const res = await publish({time});

    expect(res.status).toBe(EventarcPublishStatus.SUCCESS);
    expect(eventAttributes(onlyEvent())['time']).toBe(time);
  });

  it('test_publish_message_exception_eviction', async () => {
    publishBehavior.error = new Error('API failed');

    const res = await publish();

    expect(errorDetails(res)).toContain('API failed');
    expect(builtClients).toHaveLength(1);
    expect(builtClients[0].closeCount).toBe(1);

    // The evicted client is gone, so the next publish reconnects.
    publishBehavior.error = undefined;
    await publish();
    expect(builtClients).toHaveLength(2);
  });

  it('test_publish_message_tracing', async () => {
    propagation.setGlobalPropagator(new StubPropagator());

    const res = await publish({include_tracing_extension: true});

    expect(res.status).toBe(EventarcPublishStatus.SUCCESS);
    const attributes = eventAttributes(onlyEvent());
    expect(attributes['traceparent']).toBe('00-testtrace-testid-01');
    expect(attributes['tracestate']).toBe('teststate=1');
  });

  it('test_publish_message_empty_string_data', async () => {
    const res = await publish({data: ''});

    expect(res.status).toBe(EventarcPublishStatus.SUCCESS);
    const event = onlyEvent();
    expect(event.textData).toBeUndefined();
    expect(event.binaryData).toBeUndefined();
  });

  it('test_publish_message_empty_dict_data', async () => {
    const res = await publish({data: {}});

    expect(res.status).toBe(EventarcPublishStatus.SUCCESS);
    expect(onlyEvent().textData).toBe('{}');
  });

  it('test_publish_message_time_empty_string', async () => {
    const res = await publish({time: ''});

    expect(res.status).toBe(EventarcPublishStatus.SUCCESS);
    expect(eventAttributes(onlyEvent())).not.toHaveProperty('time');
  });

  it('test_publish_message_explicit_datacontenttype', async () => {
    const res = await publish({
      data: '<xml/>',
      datacontenttype: 'application/xml',
    });

    expect(res.status).toBe(EventarcPublishStatus.SUCCESS);
    const event = onlyEvent();
    expect(event.textData).toBe('<xml/>');
    expect(eventAttributes(event)['datacontenttype']).toBe('application/xml');
  });

  it('test_publish_message_image_payload', async () => {
    const res = await publish({
      data: 'iVBORw0KGgo=',
      is_base64_encoded: true,
      datacontenttype: 'image/png',
    });

    expect(res.status).toBe(EventarcPublishStatus.SUCCESS);
    const event = onlyEvent();
    expect(event.binaryData).toEqual(
      new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    );
    expect(eventAttributes(event)['datacontenttype']).toBe('image/png');
  });

  it('test_publish_message_explicit_datacontenttype_json_with_binary_data', async () => {
    const res = await publish({
      data: 'e30=',
      is_base64_encoded: true,
      datacontenttype: 'application/json',
    });

    expect(res.status).toBe(EventarcPublishStatus.SUCCESS);
    const event = onlyEvent();
    expect(event.binaryData).toEqual(new Uint8Array(Buffer.from('{}')));
    expect(eventAttributes(event)['datacontenttype']).toBe('application/json');
  });

  it('test_publish_message_explicit_datacontenttype_xml_with_dict_data', async () => {
    const res = await publish({
      data: {foo: 'bar'},
      datacontenttype: 'application/xml',
    });

    expect(res.status).toBe(EventarcPublishStatus.SUCCESS);
    const event = onlyEvent();
    expect(event.textData).toBe('{"foo":"bar"}');
    expect(eventAttributes(event)['datacontenttype']).toBe('application/xml');
  });

  it('test_publish_message_empty_datacontenttype', async () => {
    const res = await publish({data: 'hello', datacontenttype: ''});

    expect(res.status).toBe(EventarcPublishStatus.SUCCESS);
    const event = onlyEvent();
    expect(eventAttributes(event)).not.toHaveProperty('datacontenttype');
    expect(event.textData).toBe('hello');
  });

  it('test_publish_message_with_subject', async () => {
    const res = await publish({data: 'hello', subject: 'test-subject'});

    expect(res.status).toBe(EventarcPublishStatus.SUCCESS);
    const event = onlyEvent();
    expect(event).not.toHaveProperty('subject');
    expect(eventAttributes(event)['subject']).toBe('test-subject');
  });

  it('test_publish_message_data_integer', async () => {
    const res = await publish({data: 12345});

    expect(res.status).toBe(EventarcPublishStatus.SUCCESS);
    const event = onlyEvent();
    expect(event.textData).toBe('12345');
    expect(eventAttributes(event)['datacontenttype']).toBe('application/json');
  });

  it('test_publish_message_data_boolean', async () => {
    const res = await publish({data: true});

    expect(res.status).toBe(EventarcPublishStatus.SUCCESS);
    const event = onlyEvent();
    expect(event.textData).toBe('true');
    expect(eventAttributes(event)['datacontenttype']).toBe('application/json');
  });

  it('test_publish_message_data_list_of_dicts', async () => {
    const data = [{a: 1}, {b: 2}];

    const res = await publish({data});

    expect(res.status).toBe(EventarcPublishStatus.SUCCESS);
    const event = onlyEvent();
    expect(event.textData).toBe(JSON.stringify(data));
    expect(eventAttributes(event)['datacontenttype']).toBe('application/json');
  });

  it('test_publish_message_data_unicode', async () => {
    const res = await publish({data: 'Hello 🌍!'});

    expect(res.status).toBe(EventarcPublishStatus.SUCCESS);
    const event = onlyEvent();
    expect(event.textData).toBe('Hello 🌍!');
    expect(eventAttributes(event)['datacontenttype']).toBe('text/plain');
  });

  it('test_publish_message_custom_attributes_type_casting', async () => {
    const res = await publish({custom_attributes: {isvalid: true, count: 42}});

    expect(res.status).toBe(EventarcPublishStatus.SUCCESS);
    const attributes = eventAttributes(onlyEvent());
    expect(attributes['isvalid']).toBe('true');
    expect(attributes['count']).toBe('42');
  });

  it('test_publish_message_explicit_specversion', async () => {
    const res = await publish({specversion: '1.1'});

    expect(res.status).toBe(EventarcPublishStatus.SUCCESS);
    expect(onlyEvent().specVersion).toBe('1.1');
  });

  it('test_publish_message_explicit_id', async () => {
    const res = await publish({id: 'custom-event-id-99'});

    expect(res).toEqual({
      status: EventarcPublishStatus.SUCCESS,
      message_id: 'custom-event-id-99',
    });
    expect(onlyEvent().id).toBe('custom-event-id-99');
  });

  it('test_publish_message_base64_without_datacontenttype', async () => {
    const res = await publish({data: 'YmluYXJ5', is_base64_encoded: true});

    expect(res.status).toBe(EventarcPublishStatus.SUCCESS);
    const event = onlyEvent();
    expect(event.binaryData).toEqual(new Uint8Array(Buffer.from('binary')));
    expect(eventAttributes(event)['datacontenttype']).toBe(
      'application/octet-stream',
    );
  });

  it('test_publish_message_data_deeply_nested_dict', async () => {
    const data = {
      user: {
        id: 101,
        profile: {
          name: 'Alice',
          preferences: {
            notifications: {email: true, sms: false},
            tags: ['premium', 'beta-tester'],
          },
        },
        history: [
          {action: 'login', timestamp: '2026-06-04T00:00:00Z'},
          {action: 'purchase', details: {item_id: 999, amount: 42.5}},
        ],
      },
      metadata: {source: 'mobile-app', version: [1, 2, {build: 'rc1'}]},
    };

    const res = await publish({data});

    expect(res.status).toBe(EventarcPublishStatus.SUCCESS);
    const event = onlyEvent();
    expect(event.textData).toBe(JSON.stringify(data));
    expect(eventAttributes(event)['datacontenttype']).toBe('application/json');
  });

  it('test_publish_message_data_deeply_nested_list', async () => {
    const data = [
      [1, 2, [3, 4, [5, {six: 6}]]],
      {seven: [8, 9]},
      'ten',
      true,
      null,
      [{eleven: {twelve: [13, 14]}}],
    ];

    const res = await publish({data});

    expect(res.status).toBe(EventarcPublishStatus.SUCCESS);
    const event = onlyEvent();
    expect(event.textData).toBe(JSON.stringify(data));
    expect(eventAttributes(event)['datacontenttype']).toBe('application/json');
  });

  it('test_publish_message_auto_generated_attributes', async () => {
    const res = await publish({data: 'hello world'});

    expect(res.status).toBe(EventarcPublishStatus.SUCCESS);
    const event = onlyEvent();
    expect(event.id).toMatch(UUID_V4_PATTERN);
    const time = eventAttributes(event)['time'];
    expect(time).toBeDefined();
    expect(Number.isNaN(Date.parse(time ?? ''))).toBe(false);
  });
});
