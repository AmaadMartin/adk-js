/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {protos} from '@google-cloud/eventarc-publishing';
import {Schema, Type} from '@google/genai';
import {propagation, TextMapPropagator} from '@opentelemetry/api';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

import {
  getPublisherClient,
  removePublisherClient,
} from '../../../src/integrations/eventarc/client.js';
import {
  createPublishMessageTool,
  publishMessage,
  PublishMessageOptions,
  PublishMessageResult,
} from '../../../src/integrations/eventarc/message_tool.js';
import {createToolContext} from './eventarc_test_utils.js';

type CloudEventMessage = protos.google.cloud.eventarc.publishing.v1.ICloudEvent;
type PublishRequest =
  protos.google.cloud.eventarc.publishing.v1.IPublishRequest;

const mocks = vi.hoisted(() => ({
  publish:
    vi.fn<
      (request: PublishRequest, options: {timeout?: number}) => Promise<void>
    >(),
  close: vi.fn<() => Promise<void>>(),
  sdk: {available: true},
}));

vi.mock('../../../src/integrations/eventarc/client.js', () => ({
  getPublisherClient: vi.fn(async () => ({
    publish: mocks.publish,
    close: mocks.close,
  })),
  removePublisherClient: vi.fn(async () => {}),
  cleanupPublisherClients: vi.fn(async () => {}),
  loadPublisherClientCtor: vi.fn(async () => {
    if (!mocks.sdk.available) {
      throw new Error('@google-cloud/eventarc-publishing is not installed');
    }
    return class {};
  }),
}));

const BASE_OPTIONS: PublishMessageOptions = {
  bus: 'projects/test/locations/global/messageBuses/my-bus',
  type: 'com.example.test',
  source: '//test/source',
};

const UUID_V4_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const TOOL_CONTEXT = createToolContext();

function publishedEvent(): CloudEventMessage {
  const call = mocks.publish.mock.calls.at(-1);
  if (!call) {
    expect.fail('the publisher client was not called');
  }
  const event = call[0].protoMessage;
  if (!event) {
    expect.fail('the publish request carried no CloudEvent');
  }
  return event;
}

function publishedAttributes(): Record<string, string> {
  const attributes: Record<string, string> = {};
  for (const [key, value] of Object.entries(
    publishedEvent().attributes ?? {},
  )) {
    if (typeof value.ceString === 'string') {
      attributes[key] = value.ceString;
    }
  }
  return attributes;
}

function expectSuccess(result: PublishMessageResult): string {
  if (result.status !== 'SUCCESS') {
    expect.fail(`expected SUCCESS but got: ${result.error_details}`);
  }
  return result.message_id;
}

function expectError(result: PublishMessageResult): string {
  if (result.status !== 'ERROR') {
    expect.fail('expected ERROR but the publish succeeded');
  }
  return result.error_details;
}

async function runTool(args: Record<string, unknown>): Promise<unknown> {
  return createPublishMessageTool({}).runAsync({
    args,
    toolContext: TOOL_CONTEXT,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.sdk.available = true;
  mocks.publish.mockResolvedValue(undefined);
});

describe('publishMessage success path', () => {
  it('publishes a text payload and echoes the generated id', async () => {
    const result = await publishMessage({...BASE_OPTIONS, data: 'hello'});

    const messageId = expectSuccess(result);
    expect(messageId).toMatch(UUID_V4_PATTERN);

    const request = mocks.publish.mock.calls[0][0];
    expect(request.messageBus).toBe(BASE_OPTIONS.bus);
    expect(publishedEvent()).toMatchObject({
      id: messageId,
      source: '//test/source',
      type: 'com.example.test',
      specVersion: '1.0',
      textData: 'hello',
    });
    expect(publishedAttributes()['datacontenttype']).toBe('text/plain');
    expect(publishedAttributes()['time']).toMatch(
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/,
    );
  });

  it('applies the default publish timeout', async () => {
    await publishMessage({...BASE_OPTIONS, data: 'hello'});

    expect(mocks.publish.mock.calls[0][1]).toEqual({timeout: 15_000});
  });

  it('applies a configured publish timeout', async () => {
    await publishMessage({
      ...BASE_OPTIONS,
      data: 'hello',
      toolConfig: {publishTimeoutMs: 30_000},
    });

    expect(mocks.publish.mock.calls[0][1]).toEqual({timeout: 30_000});
  });

  it('forwards the project id and credentials to the publisher client', async () => {
    const credentialsConfig = {scopes: ['https://example.test/scope']};
    await publishMessage({
      ...BASE_OPTIONS,
      toolConfig: {projectId: 'my-project'},
      credentialsConfig,
    });

    expect(vi.mocked(getPublisherClient)).toHaveBeenCalledWith({
      credentialsConfig,
      projectId: 'my-project',
    });
  });

  it('echoes an explicitly supplied id', async () => {
    const result = await publishMessage({...BASE_OPTIONS, id: 'explicit-id'});

    expect(expectSuccess(result)).toBe('explicit-id');
    expect(publishedEvent().id).toBe('explicit-id');
  });

  it('keeps an explicit specversion', async () => {
    await publishMessage({...BASE_OPTIONS, specversion: '1.1'});

    expect(publishedEvent().specVersion).toBe('1.1');
  });

  it('puts the subject in the attributes rather than on the event', async () => {
    await publishMessage({...BASE_OPTIONS, subject: 'orders/42'});

    expect(publishedAttributes()['subject']).toBe('orders/42');
    expect(publishedEvent()).not.toHaveProperty('subject');
  });
});

describe('publishMessage content-type inference', () => {
  it('infers application/json for an object', async () => {
    await publishMessage({...BASE_OPTIONS, data: {foo: 'bar'}});

    expect(publishedAttributes()['datacontenttype']).toBe('application/json');
    expect(publishedEvent().textData).toBe('{"foo":"bar"}');
  });

  it('infers application/json for an array of objects', async () => {
    await publishMessage({...BASE_OPTIONS, data: [{a: 1}, {b: 2}]});

    expect(publishedAttributes()['datacontenttype']).toBe('application/json');
    expect(publishedEvent().textData).toBe('[{"a":1},{"b":2}]');
  });

  it('infers application/json for a number', async () => {
    await publishMessage({...BASE_OPTIONS, data: 42});

    expect(publishedAttributes()['datacontenttype']).toBe('application/json');
    expect(publishedEvent().textData).toBe('42');
  });

  it('infers application/json for a boolean', async () => {
    await publishMessage({...BASE_OPTIONS, data: true});

    expect(publishedAttributes()['datacontenttype']).toBe('application/json');
    expect(publishedEvent().textData).toBe('true');
  });

  it('infers text/plain for a unicode string', async () => {
    await publishMessage({...BASE_OPTIONS, data: 'héllo 🌍'});

    expect(publishedAttributes()['datacontenttype']).toBe('text/plain');
    expect(publishedEvent().textData).toBe('héllo 🌍');
  });

  it('infers application/octet-stream for bytes', async () => {
    const bytes = Uint8Array.from([0x89, 0x50, 0x4e, 0x47]);
    await publishMessage({...BASE_OPTIONS, data: bytes});

    expect(publishedAttributes()['datacontenttype']).toBe(
      'application/octet-stream',
    );
    expect(publishedEvent().binaryData).toBe(bytes);
    expect(publishedEvent()).not.toHaveProperty('textData');
  });

  it('serialises a deeply nested object', async () => {
    const data = {a: {b: {c: [1, {d: 'e'}]}}};
    await publishMessage({...BASE_OPTIONS, data});

    expect(publishedEvent().textData).toBe(JSON.stringify(data));
  });

  it('keeps bytes binary under an explicit application/json content type', async () => {
    const bytes = Buffer.from('binary-json');
    await publishMessage({
      ...BASE_OPTIONS,
      data: bytes,
      datacontenttype: 'application/json',
    });

    expect(publishedAttributes()['datacontenttype']).toBe('application/json');
    expect(publishedEvent().binaryData).toBe(bytes);
  });

  it('JSON-encodes an object under a non-JSON content type', async () => {
    await publishMessage({
      ...BASE_OPTIONS,
      data: {foo: 'bar'},
      datacontenttype: 'application/xml',
    });

    expect(publishedAttributes()['datacontenttype']).toBe('application/xml');
    expect(publishedEvent().textData).toBe('{"foo":"bar"}');
  });

  it('stringifies a primitive under a non-JSON content type', async () => {
    await publishMessage({
      ...BASE_OPTIONS,
      data: 42,
      datacontenttype: 'application/xml',
    });

    expect(publishedEvent().textData).toBe('42');
  });

  it('keeps an explicit content type for a string payload', async () => {
    await publishMessage({
      ...BASE_OPTIONS,
      data: '<a/>',
      datacontenttype: 'application/xml',
    });

    expect(publishedAttributes()['datacontenttype']).toBe('application/xml');
    expect(publishedEvent().textData).toBe('<a/>');
  });

  it('drops the attribute for an empty content type', async () => {
    await publishMessage({...BASE_OPTIONS, data: 'hello', datacontenttype: ''});

    expect(publishedAttributes()).not.toHaveProperty('datacontenttype');
    expect(publishedEvent().textData).toBe('hello');
  });

  it('sends no payload for an empty string', async () => {
    await publishMessage({...BASE_OPTIONS, data: ''});

    expect(publishedEvent()).not.toHaveProperty('textData');
    expect(publishedEvent()).not.toHaveProperty('binaryData');
    expect(publishedAttributes()).not.toHaveProperty('datacontenttype');
  });

  it('keeps an explicit content type even when there is no payload', async () => {
    await publishMessage({...BASE_OPTIONS, datacontenttype: 'application/xml'});

    expect(publishedAttributes()['datacontenttype']).toBe('application/xml');
    expect(publishedEvent()).not.toHaveProperty('textData');
  });

  it('serialises an empty object', async () => {
    await publishMessage({...BASE_OPTIONS, data: {}});

    expect(publishedEvent().textData).toBe('{}');
    expect(publishedAttributes()['datacontenttype']).toBe('application/json');
  });

  it('reports data that cannot be JSON-encoded', async () => {
    const result = await publishMessage({...BASE_OPTIONS, data: 1n});

    expect(expectError(result)).toContain('Failed to serialize data to JSON');
  });

  it('reports a circular payload', async () => {
    const circular: Record<string, unknown> = {};
    circular['self'] = circular;

    const result = await publishMessage({...BASE_OPTIONS, data: circular});

    expect(expectError(result)).toContain('Failed to serialize data to JSON');
  });

  it('reports a payload that JSON.stringify silently drops', async () => {
    const result = await publishMessage({...BASE_OPTIONS, data: Symbol('x')});

    expect(expectError(result)).toContain('value is not JSON-serializable');
  });

  it('reports a circular payload under a non-JSON content type', async () => {
    const circular: Record<string, unknown> = {};
    circular['self'] = circular;

    const result = await publishMessage({
      ...BASE_OPTIONS,
      data: circular,
      datacontenttype: 'application/xml',
    });

    expect(expectError(result)).toMatch(/^Failed to serialize data: /);
  });

  it('stringifies a symbol payload under a non-JSON content type', async () => {
    await publishMessage({
      ...BASE_OPTIONS,
      data: Symbol('x'),
      datacontenttype: 'application/xml',
    });

    expect(publishedEvent().textData).toBe('Symbol(x)');
  });
});

describe('publishMessage base64 payloads', () => {
  it('decodes a base64 payload into bytes', async () => {
    const result = await publishMessage({
      ...BASE_OPTIONS,
      data: Buffer.from('hello bytes').toString('base64'),
      isBase64Encoded: true,
    });

    expectSuccess(result);
    expect(publishedAttributes()['datacontenttype']).toBe(
      'application/octet-stream',
    );
    expect(Buffer.from(publishedEvent().binaryData ?? []).toString()).toBe(
      'hello bytes',
    );
  });

  it('tolerates whitespace inside a base64 payload', async () => {
    const encoded = Buffer.from('hello bytes').toString('base64');
    const result = await publishMessage({
      ...BASE_OPTIONS,
      data: `${encoded.slice(0, 4)}\n ${encoded.slice(4)}`,
      isBase64Encoded: true,
    });

    expectSuccess(result);
    expect(Buffer.from(publishedEvent().binaryData ?? []).toString()).toBe(
      'hello bytes',
    );
  });

  it('rejects a payload outside the base64 alphabet', async () => {
    const result = await publishMessage({
      ...BASE_OPTIONS,
      data: 'not!valid!base64!',
      isBase64Encoded: true,
    });

    expect(expectError(result)).toContain('Invalid base64 string');
    expect(mocks.publish).not.toHaveBeenCalled();
  });

  it('rejects a base64 payload with a truncated final group', async () => {
    const result = await publishMessage({
      ...BASE_OPTIONS,
      data: 'aGVsbG8',
      isBase64Encoded: true,
    });

    expect(expectError(result)).toContain('Invalid base64 string');
  });

  it('rejects a non-string base64 payload', async () => {
    const result = await publishMessage({
      ...BASE_OPTIONS,
      data: 123,
      isBase64Encoded: true,
    });

    expect(expectError(result)).toBe(
      'data must be a string when is_base64_encoded is true',
    );
  });
});

describe('publishMessage attribute validation', () => {
  it.each([
    {
      name: 'empty type',
      options: {type: ''},
      error: 'type must be a non-empty string',
    },
    {
      name: 'blank type',
      options: {type: '   '},
      error: 'type must be a non-empty string',
    },
    {
      name: 'empty source',
      options: {source: ''},
      error: 'source must be a non-empty string',
    },
    {
      name: 'blank id',
      options: {id: '   '},
      error: 'id, if provided, must be a non-empty string',
    },
    {
      name: 'invalid custom attribute key',
      options: {customAttributes: {'InvalidKey!': 'val'}},
      error: 'Invalid custom attribute key',
    },
    {
      name: 'invalid time format',
      options: {time: 'invalid-time'},
      error: 'Invalid RFC 3339',
    },
    {
      name: 'date without a time component',
      options: {time: '2026-06-03'},
      error: 'Invalid RFC 3339',
    },
  ])('rejects $name', async ({options, error}) => {
    const result = await publishMessage({...BASE_OPTIONS, ...options});

    expect(expectError(result)).toContain(error);
    expect(mocks.publish).not.toHaveBeenCalled();
  });

  it.each([
    '2026-06-03T12:00:00Z',
    '2026-06-03T12:00:00.123456Z',
    '2026-06-03T12:00:00+00:00',
    '2026-06-03T12:00:00-07:00',
    '2026-06-03T12:00:00.123+02:00',
  ])('accepts the RFC 3339 timestamp %s', async (time) => {
    const result = await publishMessage({...BASE_OPTIONS, time});

    expectSuccess(result);
    expect(publishedAttributes()['time']).toBe(time);
  });

  it('drops the time attribute for an empty string', async () => {
    await publishMessage({...BASE_OPTIONS, time: ''});

    expect(publishedAttributes()).not.toHaveProperty('time');
  });

  it('coerces custom attribute values to strings', async () => {
    await publishMessage({
      ...BASE_OPTIONS,
      customAttributes: {flag: true, count: 7, name: 'abc'},
    });

    expect(publishedAttributes()).toMatchObject({
      flag: 'true',
      count: '7',
      name: 'abc',
    });
  });

  it('accepts digit-only custom attribute keys', async () => {
    await publishMessage({...BASE_OPTIONS, customAttributes: {'123': 'ok'}});

    expect(publishedAttributes()['123']).toBe('ok');
  });
});

/** Minimal W3C-style propagator so the tracing extension has something to inject. */
const TEST_PROPAGATOR: TextMapPropagator = {
  inject(_context, carrier, setter) {
    setter.set(carrier, 'traceparent', '00-trace-span-01');
    setter.set(carrier, 'tracestate', 'vendor=1');
  },
  extract(activeContext) {
    return activeContext;
  },
  fields() {
    return ['traceparent', 'tracestate'];
  },
};

describe('publishMessage tracing extension', () => {
  afterEach(() => {
    propagation.disable();
  });

  it('copies the active trace context into the attributes', async () => {
    propagation.setGlobalPropagator(TEST_PROPAGATOR);

    await publishMessage({...BASE_OPTIONS, includeTracingExtension: true});

    expect(publishedAttributes()).toMatchObject({
      traceparent: '00-trace-span-01',
      tracestate: 'vendor=1',
    });
  });

  it('adds nothing when no propagator is registered', async () => {
    await publishMessage({...BASE_OPTIONS, includeTracingExtension: true});

    expect(publishedAttributes()).not.toHaveProperty('traceparent');
    expect(publishedAttributes()).not.toHaveProperty('tracestate');
  });

  it('adds nothing when the tracing extension is not requested', async () => {
    propagation.setGlobalPropagator(TEST_PROPAGATOR);

    await publishMessage(BASE_OPTIONS);

    expect(publishedAttributes()).not.toHaveProperty('traceparent');
  });
});

describe('publishMessage failure handling', () => {
  it('reports a missing SDK before validating anything else', async () => {
    mocks.sdk.available = false;

    const result = await publishMessage({...BASE_OPTIONS, type: ''});

    expect(expectError(result)).toBe(
      '@google-cloud/eventarc-publishing is not installed',
    );
  });

  it('evicts the cached client when the publish call fails', async () => {
    mocks.publish.mockRejectedValue(new Error('API failed'));

    const result = await publishMessage({
      ...BASE_OPTIONS,
      toolConfig: {projectId: 'my-project'},
    });

    expect(expectError(result)).toBe('API failed');
    expect(vi.mocked(removePublisherClient)).toHaveBeenCalledWith({
      credentialsConfig: undefined,
      projectId: 'my-project',
    });
  });

  it('reports a non-Error rejection from the publisher client', async () => {
    mocks.publish.mockRejectedValue('transport exploded');

    const result = await publishMessage(BASE_OPTIONS);

    expect(expectError(result)).toBe('transport exploded');
  });

  it('does not evict the cached client for a validation failure', async () => {
    const result = await publishMessage({...BASE_OPTIONS, type: ''});

    expect(expectError(result)).toBe('type must be a non-empty string');
    expect(vi.mocked(removePublisherClient)).not.toHaveBeenCalled();
  });
});

describe('createPublishMessageTool', () => {
  it('declares the model-facing CloudEvent parameters', () => {
    const tool = createPublishMessageTool({});

    expect(tool.name).toBe('publish_message');
    const parameters: Schema | undefined = tool._getDeclaration()?.parameters;
    expect(parameters?.required).toEqual(['bus', 'type', 'source']);
    expect(Object.keys(parameters?.properties ?? {})).toEqual([
      'bus',
      'type',
      'source',
      'data',
      'is_base64_encoded',
      'include_tracing_extension',
      'datacontenttype',
      'specversion',
      'subject',
      'id',
      'time',
      'custom_attributes',
    ]);
    expect(parameters?.properties?.['data']?.type).toBe(Type.STRING);
    expect(parameters?.properties?.['is_base64_encoded']?.type).toBe(
      Type.BOOLEAN,
    );
    expect(parameters?.properties?.['custom_attributes']?.type).toBe(
      Type.OBJECT,
    );
  });

  it('publishes with the snake_case arguments the model supplies', async () => {
    const result = await runTool({
      bus: BASE_OPTIONS.bus,
      type: BASE_OPTIONS.type,
      source: BASE_OPTIONS.source,
      data: 'hello',
      is_base64_encoded: false,
      subject: 'orders/42',
      custom_attributes: {region: 'eu'},
    });

    expect(result).toEqual({
      status: 'SUCCESS',
      message_id: expect.stringMatching(UUID_V4_PATTERN),
    });
    expect(publishedAttributes()).toMatchObject({
      subject: 'orders/42',
      region: 'eu',
    });
  });

  it('forwards the toolset configuration to the publisher client', async () => {
    const credentialsConfig = {scopes: ['https://example.test/scope']};
    const tool = createPublishMessageTool({
      toolConfig: {projectId: 'configured-project', publishTimeoutMs: 5_000},
      credentialsConfig,
    });

    await tool.runAsync({
      args: {
        bus: BASE_OPTIONS.bus,
        type: BASE_OPTIONS.type,
        source: BASE_OPTIONS.source,
      },
      toolContext: TOOL_CONTEXT,
    });

    expect(vi.mocked(getPublisherClient)).toHaveBeenCalledWith({
      credentialsConfig,
      projectId: 'configured-project',
    });
    expect(mocks.publish.mock.calls[0][1]).toEqual({timeout: 5_000});
  });

  it('decodes base64 data requested by the model', async () => {
    await runTool({
      bus: BASE_OPTIONS.bus,
      type: BASE_OPTIONS.type,
      source: BASE_OPTIONS.source,
      data: Buffer.from('bytes from the model').toString('base64'),
      is_base64_encoded: true,
    });

    expect(Buffer.from(publishedEvent().binaryData ?? []).toString()).toBe(
      'bytes from the model',
    );
  });

  it('rejects a non-string time from the model', async () => {
    const result = await runTool({
      bus: BASE_OPTIONS.bus,
      type: BASE_OPTIONS.type,
      source: BASE_OPTIONS.source,
      time: 12345,
    });

    expect(result).toEqual({
      status: 'ERROR',
      error_details: 'time must be a string',
    });
  });

  it('rejects non-object custom attributes from the model', async () => {
    const result = await runTool({
      bus: BASE_OPTIONS.bus,
      type: BASE_OPTIONS.type,
      source: BASE_OPTIONS.source,
      custom_attributes: 'not an object',
    });

    expect(result).toEqual({
      status: 'ERROR',
      error_details: 'custom_attributes must be an object',
    });
  });

  it('rejects a non-string type from the model', async () => {
    const result = await runTool({
      bus: BASE_OPTIONS.bus,
      type: 123,
      source: BASE_OPTIONS.source,
    });

    expect(result).toEqual({
      status: 'ERROR',
      error_details: 'type must be a non-empty string',
    });
  });

  it('rejects a non-string source from the model', async () => {
    const result = await runTool({
      bus: BASE_OPTIONS.bus,
      type: BASE_OPTIONS.type,
      source: {nested: true},
    });

    expect(result).toEqual({
      status: 'ERROR',
      error_details: 'source must be a non-empty string',
    });
  });

  it('rejects a non-string id from the model', async () => {
    const result = await runTool({
      bus: BASE_OPTIONS.bus,
      type: BASE_OPTIONS.type,
      source: BASE_OPTIONS.source,
      id: 42,
    });

    expect(result).toEqual({
      status: 'ERROR',
      error_details: 'id, if provided, must be a non-empty string',
    });
  });

  it('ignores a non-string optional attribute the reference does not validate', async () => {
    await runTool({
      bus: BASE_OPTIONS.bus,
      type: BASE_OPTIONS.type,
      source: BASE_OPTIONS.source,
      datacontenttype: 7,
      specversion: 7,
      subject: 7,
    });

    expect(publishedEvent().specVersion).toBe('1.0');
    expect(publishedAttributes()).not.toHaveProperty('subject');
    expect(publishedAttributes()).not.toHaveProperty('datacontenttype');
  });

  it('reports a missing type when the model sends no arguments', async () => {
    const result = await createPublishMessageTool({}).runAsync({
      args: {},
      toolContext: TOOL_CONTEXT,
    });

    expect(result).toEqual({
      status: 'ERROR',
      error_details: 'type must be a non-empty string',
    });
  });
});
