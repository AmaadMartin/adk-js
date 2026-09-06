/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/** Publishing a CloudEvent to an Eventarc Advanced message bus. */

import {context, propagation} from '@opentelemetry/api';
import {z} from 'zod';
import {randomUUID} from '../../utils/env_aware_utils.js';
import {formatError} from '../../utils/error_utils.js';
import {
  getPublisherClient,
  removePublisherClient,
  type PublisherClientRequest,
} from './client.js';
import {
  DEFAULT_PUBLISH_TIMEOUT_MS,
  type EventarcCredentialsConfig,
  type EventarcToolConfig,
} from './config.js';
import type {
  CloudEvent,
  CloudEventAttributeValue,
  PublishRequest,
} from './sdk.js';

/** The CloudEvents specification version used when the caller names none. */
const DEFAULT_SPEC_VERSION = '1.0';

/** Content type inferred for a structured payload. */
const JSON_CONTENT_TYPE = 'application/json';

/** Content type inferred for a string payload. */
const TEXT_CONTENT_TYPE = 'text/plain';

/** Content type inferred for a binary payload. */
const BINARY_CONTENT_TYPE = 'application/octet-stream';

/** The W3C trace-context keys copied into the event's attributes. */
const TRACE_ATTRIBUTE_KEYS = ['traceparent', 'tracestate'];

/** A base64 body: the alphabet, then at most two padding characters. */
const BASE64_PATTERN = /^[A-Za-z0-9+/]*={0,2}$/;

/** An RFC 3339 timestamp. The offset is optional, as it is in adk-python. */
const RFC_3339_PATTERN =
  /^\d{4}-\d{2}-\d{2}[Tt ]\d{2}:\d{2}:\d{2}(\.\d+)?([Zz]|[+-]\d{2}:\d{2})?$/;

/** A custom attribute key, which CloudEvents restricts to [a-z0-9]. */
const LOWERCASE_ALPHANUMERIC_PATTERN = /^[a-z0-9]+$/;

/**
 * At least one lowercase letter, because adk-python tests the key with
 * `str.islower()`, which is false for a digits-only key.
 */
const LOWERCASE_LETTER_PATTERN = /[a-z]/;

/** The outcome reported back to the model. */
export enum EventarcPublishStatus {
  SUCCESS = 'SUCCESS',
  ERROR = 'ERROR',
}

/** What `publish_message` returns. The field names are shared with adk-python. */
export type PublishMessageResult =
  | {status: EventarcPublishStatus.SUCCESS; message_id: string}
  | {status: EventarcPublishStatus.ERROR; error_details: string};

/** The model-facing schema of the `publish_message` tool. */
export const publishMessageSchema = z.object({
  bus: z
    .string()
    .describe(
      'The fully-qualified resource name of the Eventarc Advanced message ' +
        'bus, in the form projects/*/locations/*/messageBuses/*.',
    ),
  type: z
    .string()
    .describe(
      'The CloudEvents type attribute, describing the kind of occurrence ' +
        "(for example 'com.example.object.created').",
    ),
  source: z
    .string()
    .describe(
      'The CloudEvents source attribute: a URI reference identifying the ' +
        'context the event happened in.',
    ),
  data: z
    .unknown()
    .optional()
    .describe(
      'The payload of the event. Send binary data as a base64 string with ' +
        'is_base64_encoded set to true.',
    ),
  is_base64_encoded: z
    .boolean()
    .optional()
    .describe(
      'Set to true only when data is a base64 string standing for binary ' +
        'data. The tool decodes it into raw bytes before publishing.',
    ),
  include_tracing_extension: z
    .boolean()
    .optional()
    .describe(
      "Set to true to copy the caller's W3C trace context into the event's " +
        'attributes.',
    ),
  datacontenttype: z
    .string()
    .optional()
    .describe(
      'The MIME type of the data. Inferred from the payload when omitted. ' +
        'Pass an empty string to leave the attribute off the event.',
    ),
  specversion: z
    .string()
    .optional()
    .describe(
      `The CloudEvents specification version. Defaults to ${DEFAULT_SPEC_VERSION}.`,
    ),
  subject: z
    .string()
    .optional()
    .describe('The subject of the event in the producer\u2019s own terms.'),
  id: z
    .string()
    .optional()
    .describe(
      'The unique id of the event. A UUIDv4 is generated when omitted.',
    ),
  time: z
    .string()
    .optional()
    .describe(
      'The event timestamp in RFC 3339 format. The current time is used ' +
        'when omitted. Pass an empty string to leave the attribute off the ' +
        'event.',
    ),
  custom_attributes: z
    .record(z.string(), z.string())
    .optional()
    .describe(
      'Extra CloudEvent attributes. Keys must be lowercase alphanumeric.',
    ),
});

/**
 * The arguments {@link publishMessage} accepts.
 *
 * Wider than {@link publishMessageSchema} for the fields the function checks
 * itself, because a caller reaching the function directly is not bound by the
 * schema the model sees.
 */
export interface PublishMessageInput {
  bus: string;
  type: string;
  source: string;
  data?: unknown;
  is_base64_encoded?: boolean;
  include_tracing_extension?: boolean;
  datacontenttype?: string;
  specversion?: string;
  subject?: string;
  id?: string;
  time?: unknown;
  custom_attributes?: unknown;
}

/** What the toolset binds to the tool, out of the model's reach. */
export interface PublishMessageOptions {
  /** How the publisher client authenticates. */
  credentialsConfig?: EventarcCredentialsConfig;
  /** The project id and publish timeout. */
  toolConfig?: EventarcToolConfig;
}

/** The event body, carried by exactly one of the CloudEvent data fields. */
interface EventPayload {
  contentType?: string;
  textData?: string;
  binaryData?: Uint8Array;
}

/** Whether a value is binary data the SDK can carry as `binaryData`. */
function isBytes(value: unknown): value is Uint8Array {
  return value instanceof Uint8Array;
}

/** Whether a value serializes to a JSON object or array. */
function isJsonContainer(value: unknown): boolean {
  return typeof value === 'object' && value !== null;
}

/** Returns `value`, or throws `message` when it is blank. */
function requireNonBlank(value: string, message: string): string {
  if (value.trim() === '') {
    throw new Error(message);
  }
  return value;
}

/**
 * Decodes a base64 payload.
 *
 * @param data The value the caller marked as base64.
 * @return The decoded bytes.
 * @throws If `data` is not a string, or is not valid base64.
 */
function decodeBase64Payload(data: unknown): Uint8Array {
  if (typeof data !== 'string') {
    throw new Error('data must be a string when is_base64_encoded is True');
  }
  const compact = data.replace(/\s+/g, '');
  if (compact.length % 4 !== 0 || !BASE64_PATTERN.test(compact)) {
    throw new Error(`Invalid base64 string: ${data}`);
  }
  return new Uint8Array(Buffer.from(compact, 'base64'));
}

/** Returns the caller's event id, or a fresh UUIDv4 when there is none. */
function resolveId(id?: string): string {
  return id === undefined
    ? randomUUID()
    : requireNonBlank(id, 'id, if provided, must be a non-empty string');
}

/** Whether a string is a timestamp the CloudEvent can carry. */
function isRfc3339(value: string): boolean {
  return RFC_3339_PATTERN.test(value) && !Number.isNaN(Date.parse(value));
}

/** Whether a custom attribute key is one CloudEvents accepts. */
function isValidAttributeKey(key: string): boolean {
  return (
    LOWERCASE_ALPHANUMERIC_PATTERN.test(key) &&
    LOWERCASE_LETTER_PATTERN.test(key)
  );
}

/**
 * Resolves the event's `time` attribute.
 *
 * @param time The caller's value: absent for "now", empty for "no attribute".
 * @return The timestamp to publish, or `undefined` to omit the attribute.
 * @throws If `time` is not a string, or is not RFC 3339.
 */
function resolveTime(time: unknown): string | undefined {
  if (time === undefined || time === null) {
    return new Date().toISOString();
  }
  if (typeof time !== 'string') {
    throw new Error('time must be a string');
  }
  if (time === '') {
    return undefined;
  }
  if (!isRfc3339(time)) {
    throw new Error(`Invalid RFC 3339 time format: ${time}`);
  }
  return time;
}

/**
 * Validates the caller's custom attributes and stringifies their values.
 *
 * @param custom The caller's attribute map.
 * @return The attributes, with every value a string.
 * @throws If `custom` is not an object, or holds a key CloudEvents rejects.
 */
function collectCustomAttributes(custom: unknown): Record<string, string> {
  const attributes: Record<string, string> = {};
  if (custom === undefined || custom === null) {
    return attributes;
  }
  if (!isJsonContainer(custom) || Array.isArray(custom)) {
    throw new Error('custom_attributes must be a dict');
  }
  const entries: Array<[string, unknown]> = Object.entries(custom);
  for (const [key, value] of entries) {
    if (!isValidAttributeKey(key)) {
      throw new Error(
        `Invalid custom attribute key: ${key}. Keys must be lowercase alphanumeric.`,
      );
    }
    attributes[key] = String(value);
  }
  return attributes;
}

/** Serializes a value to JSON, reporting a failure under `message`. */
function toJson(data: unknown, message: string): string {
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(data);
  } catch (err: unknown) {
    throw new Error(`${message}: ${formatError(err)}`);
  }
  if (serialized === undefined) {
    throw new Error(`${message}: the value has no JSON representation`);
  }
  return serialized;
}

/** The content type adk-python infers for a payload the caller did not type. */
function inferContentType(data: unknown): string {
  if (isBytes(data)) {
    return BINARY_CONTENT_TYPE;
  }
  if (typeof data === 'string') {
    return TEXT_CONTENT_TYPE;
  }
  return JSON_CONTENT_TYPE;
}

/**
 * Turns the caller's payload into the CloudEvent data field that carries it.
 *
 * An absent payload still keeps the caller's declared content type, so
 * `datacontenttype` reaches the event even with no body.
 *
 * @param data The payload, already base64-decoded when it was encoded.
 * @param declared The caller's `datacontenttype`, if any.
 * @return The resolved content type and the body field to publish.
 * @throws If the payload cannot be serialized.
 */
function toEventPayload(data: unknown, declared?: string): EventPayload {
  if (data === undefined || data === null || data === '') {
    return {contentType: declared};
  }
  const contentType = declared ?? inferContentType(data);
  if (isBytes(data)) {
    return {contentType, binaryData: data};
  }
  if (contentType === JSON_CONTENT_TYPE) {
    return typeof data === 'string'
      ? {contentType, textData: data}
      : {
          contentType,
          textData: toJson(data, 'Failed to serialize data to JSON'),
        };
  }
  // `String` is total for every non-object value that reaches here, so
  // adk-python's `str()` failure branch has no counterpart.
  return isJsonContainer(data)
    ? {contentType, textData: toJson(data, 'Failed to serialize data')}
    : {contentType, textData: String(data)};
}

/** Copies the caller's W3C trace context into the event's attributes. */
function injectTracingAttributes(attributes: Record<string, string>): void {
  const carrier: Record<string, string> = {};
  propagation.inject(context.active(), carrier);
  for (const key of TRACE_ATTRIBUTE_KEYS) {
    const value = carrier[key];
    if (value !== undefined) {
      attributes[key] = value;
    }
  }
}

/** Adds an attribute, unless the value is absent or empty. */
function setAttribute(
  attributes: Record<string, string>,
  key: string,
  value?: string,
): void {
  if (value !== undefined && value !== '') {
    attributes[key] = value;
  }
}

/** Wraps each attribute in the SDK's string-valued attribute message. */
function toAttributeValues(
  attributes: Record<string, string>,
): Record<string, CloudEventAttributeValue> {
  return Object.fromEntries(
    Object.entries(attributes).map(([key, value]) => [key, {ceString: value}]),
  );
}

/**
 * Builds the CloudEvent to publish.
 *
 * @param input The caller's arguments.
 * @param id The event id, generated when the caller supplied none.
 * @return The event in the wire shape the publishing API accepts.
 * @throws If any argument is invalid, with the message reported to the model.
 */
function buildCloudEvent(input: PublishMessageInput, id: string): CloudEvent {
  const type = requireNonBlank(input.type, 'type must be a non-empty string');
  const source = requireNonBlank(
    input.source,
    'source must be a non-empty string',
  );
  const data =
    input.is_base64_encoded === true
      ? decodeBase64Payload(input.data)
      : input.data;

  const attributes = collectCustomAttributes(input.custom_attributes);
  const time = resolveTime(input.time);
  const payload = toEventPayload(data, input.datacontenttype);

  if (input.include_tracing_extension === true) {
    injectTracingAttributes(attributes);
  }
  setAttribute(attributes, 'datacontenttype', payload.contentType);
  setAttribute(attributes, 'time', time);
  setAttribute(attributes, 'subject', input.subject);

  const event: CloudEvent = {
    id,
    source,
    type,
    specVersion: input.specversion ?? DEFAULT_SPEC_VERSION,
    attributes: toAttributeValues(attributes),
  };
  if (payload.textData !== undefined) {
    event.textData = payload.textData;
  }
  if (payload.binaryData !== undefined) {
    event.binaryData = payload.binaryData;
  }
  return event;
}

/**
 * Publishes a CloudEvent to a Google Cloud Eventarc Advanced message bus.
 *
 * The call is fire-and-forget: it reports whether the bus accepted the event,
 * not what any subscriber did with it. Every failure comes back as
 * `{status: ERROR, error_details}`, so the model can read the reason and try
 * again; the function does not throw.
 *
 * @param input The event to publish.
 * @param options The credentials and settings the toolset binds to the tool.
 * @return The published event's id, or the reason it was not published.
 */
export async function publishMessage(
  input: PublishMessageInput,
  options: PublishMessageOptions = {},
): Promise<PublishMessageResult> {
  let id: string;
  let event: CloudEvent;
  try {
    id = resolveId(input.id);
    event = buildCloudEvent(input, id);
  } catch (err: unknown) {
    return {
      status: EventarcPublishStatus.ERROR,
      error_details: formatError(err),
    };
  }

  const clientRequest: PublisherClientRequest = {
    credentialsConfig: options.credentialsConfig,
    projectId: options.toolConfig?.projectId,
  };
  const request: PublishRequest = {
    messageBus: input.bus,
    protoMessage: event,
  };
  try {
    const client = await getPublisherClient(clientRequest);
    await client.publish(request, {
      timeout:
        options.toolConfig?.publishTimeoutMs ?? DEFAULT_PUBLISH_TIMEOUT_MS,
    });
    return {status: EventarcPublishStatus.SUCCESS, message_id: id};
  } catch (err: unknown) {
    await removePublisherClient(clientRequest);
    return {
      status: EventarcPublishStatus.ERROR,
      error_details: formatError(err),
    };
  }
}
