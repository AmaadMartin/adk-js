/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type {protos} from '@google-cloud/eventarc-publishing';
import {Schema, Type} from '@google/genai';
import {context, propagation} from '@opentelemetry/api';

import {BaseTool} from '../../tools/base_tool.js';
import {FunctionTool} from '../../tools/function_tool.js';
import {randomUUID} from '../../utils/env_aware_utils.js';
import {isRecord} from '../../utils/object_utils.js';
import {
  getPublisherClient,
  loadPublisherClientCtor,
  removePublisherClient,
} from './client.js';
import {
  CUSTOM_ATTRIBUTE_KEY_PATTERN,
  EventarcCredentialsConfig,
  EventarcToolConfig,
  resolvePublishTimeoutMs,
} from './config.js';

type CloudEventMessage = protos.google.cloud.eventarc.publishing.v1.ICloudEvent;
type CloudEventAttributeValue =
  protos.google.cloud.eventarc.publishing.v1.CloudEvent.ICloudEventAttributeValue;

/** Name of the generic publish tool exposed by {@link EventarcToolset}. */
export const PUBLISH_MESSAGE_TOOL_NAME = 'publish_message';

/** CloudEvents specification version used when the caller does not set one. */
const DEFAULT_SPEC_VERSION = '1.0';

const CONTENT_TYPE_JSON = 'application/json';
const CONTENT_TYPE_TEXT = 'text/plain';
const CONTENT_TYPE_OCTET_STREAM = 'application/octet-stream';

/** Canonical base64 alphabet with at most two padding characters. */
const BASE64_PATTERN = /^[A-Za-z0-9+/]*={0,2}$/;

const RFC_3339_PATTERN =
  /^\d{4}-\d{2}-\d{2}[Tt]\d{2}:\d{2}:\d{2}(\.\d+)?([Zz]|[+-]\d{2}:\d{2})$/;

const ERROR_INVALID_TYPE = 'type must be a non-empty string';
const ERROR_INVALID_SOURCE = 'source must be a non-empty string';
const ERROR_INVALID_ID = 'id, if provided, must be a non-empty string';
const ERROR_INVALID_TIME = 'time must be a string';
const ERROR_INVALID_CUSTOM_ATTRIBUTES = 'custom_attributes must be an object';
const ERROR_INVALID_BASE64_DATA =
  'data must be a string when is_base64_encoded is true';

/** Arguments accepted by {@link publishMessage}. */
export interface PublishMessageOptions {
  /**
   * Fully-qualified message bus resource name, in the form
   * `projects/{project}/locations/{location}/messageBuses/{messageBus}`.
   */
  bus: string;

  /** CloudEvents `type` attribute, e.g. `com.example.object.created`. */
  type: string;

  /** CloudEvents `source` attribute; a URI-reference identifying the producer. */
  source: string;

  /** Tool configuration supplying the project ID and publish timeout. */
  toolConfig?: EventarcToolConfig;

  /** Credentials used to build the publisher client. */
  credentialsConfig?: EventarcCredentialsConfig;

  /** Event payload. Omit to publish an event without data. */
  data?: unknown;

  /** Set when `data` is a base64-encoded string that must be published as bytes. */
  isBase64Encoded?: boolean;

  /** Set to copy the active W3C trace context into the event attributes. */
  includeTracingExtension?: boolean;

  /** MIME type of the payload. Inferred from `data` when omitted. */
  datacontenttype?: string;

  /** CloudEvents `specversion`. Defaults to `1.0`. */
  specversion?: string;

  /** CloudEvents `subject` attribute. */
  subject?: string;

  /** CloudEvents `id`. A UUID is generated when omitted. */
  id?: string;

  /**
   * RFC 3339 timestamp. The current time is used when omitted; pass an empty
   * string to drop the attribute entirely.
   */
  time?: string;

  /** Extension attributes. Keys must be lower-case alphanumeric. */
  customAttributes?: Record<string, unknown>;
}

/**
 * Outcome of a publish attempt.
 *
 * The keys stay snake_case and the status strings stay upper-case because the
 * model reads them, matching the Python reference.
 */
export type PublishMessageResult =
  | {status: 'SUCCESS'; message_id: string}
  | {status: 'ERROR'; error_details: string};

/**
 * Publishes a CloudEvent to an Eventarc Advanced message bus.
 *
 * Never throws: invalid input and transport failures are reported as an
 * `ERROR` result so that the model can react to them.
 */
export async function publishMessage(
  options: PublishMessageOptions,
): Promise<PublishMessageResult> {
  try {
    await loadPublisherClientCtor();
  } catch (error: unknown) {
    return errorResult(error);
  }

  let prepared: PreparedCloudEvent;
  try {
    prepared = buildCloudEvent(options);
  } catch (error: unknown) {
    return errorResult(error);
  }

  const clientOptions = {
    credentialsConfig: options.credentialsConfig,
    projectId: options.toolConfig?.projectId,
  };

  try {
    const client = await getPublisherClient(clientOptions);
    await client.publish(
      {messageBus: options.bus, protoMessage: prepared.message},
      {timeout: resolvePublishTimeoutMs(options.toolConfig)},
    );
    return {status: 'SUCCESS', message_id: prepared.id};
  } catch (error: unknown) {
    await removePublisherClient(clientOptions);
    return errorResult(error);
  }
}

/** Model-facing declaration of the generic `publish_message` tool. */
const PUBLISH_MESSAGE_PARAMETERS: Schema = {
  type: Type.OBJECT,
  properties: {
    bus: {
      type: Type.STRING,
      description:
        'Fully-qualified Eventarc Advanced message bus resource name, in the ' +
        'form projects/{project}/locations/{location}/messageBuses/{bus}.',
    },
    type: {
      type: Type.STRING,
      description:
        'CloudEvents type describing the occurrence, e.g. ' +
        'com.example.object.created.',
    },
    source: {
      type: Type.STRING,
      description:
        'CloudEvents source; a URI-reference identifying the context in which ' +
        'the event happened.',
    },
    data: {
      type: Type.STRING,
      description:
        'Event payload. Send structured payloads as a JSON-encoded string. To ' +
        'send binary data, base64-encode it and set is_base64_encoded to true.',
    },
    is_base64_encoded: {
      type: Type.BOOLEAN,
      description:
        'Set to true only when data is a base64-encoded string that should be ' +
        'published as raw bytes.',
    },
    include_tracing_extension: {
      type: Type.BOOLEAN,
      description:
        'Set to true to copy the active distributed tracing context into the ' +
        'event attributes.',
    },
    datacontenttype: {
      type: Type.STRING,
      description:
        'MIME type of the payload. Inferred from data when omitted; pass an ' +
        'empty string to drop the attribute.',
    },
    specversion: {
      type: Type.STRING,
      description: `CloudEvents specification version. Defaults to ${DEFAULT_SPEC_VERSION}.`,
    },
    subject: {
      type: Type.STRING,
      description: 'Subject of the event in the context of the producer.',
    },
    id: {
      type: Type.STRING,
      description: 'Unique event id. A UUID is generated when omitted.',
    },
    time: {
      type: Type.STRING,
      description:
        'RFC 3339 timestamp of the event. The current time is used when ' +
        'omitted; pass an empty string to drop the attribute.',
    },
    custom_attributes: {
      type: Type.OBJECT,
      description:
        'Extension attributes. Keys must be lower-case alphanumeric and must ' +
        'not shadow a standard CloudEvent attribute.',
    },
  },
  required: ['bus', 'type', 'source'],
};

/**
 * Builds the generic `publish_message` tool, which lets the model supply every
 * CloudEvent attribute itself.
 */
export function createPublishMessageTool(options: {
  toolConfig?: EventarcToolConfig;
  credentialsConfig?: EventarcCredentialsConfig;
}): BaseTool {
  return new FunctionTool({
    name: PUBLISH_MESSAGE_TOOL_NAME,
    description:
      'Publishes a structured CloudEvent to a Google Cloud Eventarc Advanced ' +
      'message bus so that downstream subscribers receive it.',
    parameters: PUBLISH_MESSAGE_PARAMETERS,
    async execute(input: unknown): Promise<PublishMessageResult> {
      let publishOptions: PublishMessageOptions;
      try {
        publishOptions = toPublishMessageOptions(asRecord(input), options);
      } catch (error: unknown) {
        return errorResult(error);
      }
      return publishMessage(publishOptions);
    },
  });
}

interface PreparedCloudEvent {
  /** Assembled CloudEvent proto message. */
  message: CloudEventMessage;
  /** Event id echoed back to the model as `message_id`. */
  id: string;
}

interface SerializedData {
  datacontenttype?: string;
  textData?: string;
  binaryData?: Uint8Array;
}

function buildCloudEvent(options: PublishMessageOptions): PreparedCloudEvent {
  requireNonEmptyString(options.type, ERROR_INVALID_TYPE);
  requireNonEmptyString(options.source, ERROR_INVALID_SOURCE);
  if (options.id !== undefined) {
    requireNonEmptyString(options.id, ERROR_INVALID_ID);
  }

  const data = options.isBase64Encoded
    ? decodeBase64(options.data)
    : options.data;
  const attributes = buildCustomAttributes(options.customAttributes);
  const time = resolveEventTime(options.time);
  const serialized = serializeData(data, options.datacontenttype);

  if (options.includeTracingExtension) {
    Object.assign(attributes, activeTraceAttributes());
  }
  if (serialized.datacontenttype) {
    attributes['datacontenttype'] = serialized.datacontenttype;
  }
  if (time) {
    attributes['time'] = time;
  }
  if (options.subject) {
    attributes['subject'] = options.subject;
  }

  const id = options.id ?? randomUUID();
  const message: CloudEventMessage = {
    id,
    source: options.source,
    type: options.type,
    specVersion: options.specversion ?? DEFAULT_SPEC_VERSION,
    attributes: toAttributeValues(attributes),
  };
  if (serialized.textData !== undefined) {
    message.textData = serialized.textData;
  }
  if (serialized.binaryData !== undefined) {
    message.binaryData = serialized.binaryData;
  }

  return {message, id};
}

function requireNonEmptyString(value: unknown, message: string): void {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(message);
  }
}

/**
 * Decodes a base64 payload.
 *
 * `Buffer.from(value, 'base64')` silently discards characters outside the
 * base64 alphabet, so the input is validated before it is decoded.
 */
function decodeBase64(data: unknown): Uint8Array {
  if (typeof data !== 'string') {
    throw new Error(ERROR_INVALID_BASE64_DATA);
  }
  const compact = data.replace(/\s/g, '');
  if (!BASE64_PATTERN.test(compact) || compact.length % 4 !== 0) {
    throw new Error('Invalid base64 string: the value is not valid base64');
  }
  return Buffer.from(compact, 'base64');
}

function buildCustomAttributes(
  customAttributes: Record<string, unknown> | undefined,
): Record<string, string> {
  const attributes: Record<string, string> = {};
  if (!customAttributes) {
    return attributes;
  }
  for (const [key, value] of Object.entries(customAttributes)) {
    if (!CUSTOM_ATTRIBUTE_KEY_PATTERN.test(key)) {
      throw new Error(
        `Invalid custom attribute key: ${key}. Keys must be lowercase alphanumeric.`,
      );
    }
    attributes[key] = String(value);
  }
  return attributes;
}

function resolveEventTime(time: string | undefined): string | undefined {
  if (time === undefined) {
    return new Date().toISOString();
  }
  if (time === '') {
    return undefined;
  }
  if (!RFC_3339_PATTERN.test(time) || Number.isNaN(Date.parse(time))) {
    throw new Error(`Invalid RFC 3339 time format: ${time}`);
  }
  return time;
}

function serializeData(
  data: unknown,
  declaredContentType: string | undefined,
): SerializedData {
  if (data === undefined || data === null || data === '') {
    return {datacontenttype: declaredContentType};
  }

  const datacontenttype = declaredContentType ?? inferContentType(data);
  const failureMessage =
    datacontenttype === CONTENT_TYPE_JSON
      ? 'Failed to serialize data to JSON'
      : 'Failed to serialize data';

  if (isBinaryData(data)) {
    return {datacontenttype, binaryData: data};
  }
  if (typeof data === 'string') {
    return {datacontenttype, textData: data};
  }
  if (datacontenttype === CONTENT_TYPE_JSON || typeof data === 'object') {
    return {datacontenttype, textData: stringify(data, failureMessage)};
  }
  return {datacontenttype, textData: String(data)};
}

function inferContentType(data: unknown): string {
  if (isBinaryData(data)) {
    return CONTENT_TYPE_OCTET_STREAM;
  }
  if (typeof data === 'string') {
    return CONTENT_TYPE_TEXT;
  }
  return CONTENT_TYPE_JSON;
}

/**
 * Recognises `Uint8Array` and `Buffer` without `instanceof`, so values created
 * in another realm are still detected.
 */
function isBinaryData(value: unknown): value is Uint8Array {
  return Object.prototype.toString.call(value) === '[object Uint8Array]';
}

function stringify(value: unknown, failureMessage: string): string {
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(value);
  } catch (error: unknown) {
    throw new Error(`${failureMessage}: ${toErrorMessage(error)}`);
  }
  if (serialized === undefined) {
    throw new Error(`${failureMessage}: value is not JSON-serializable`);
  }
  return serialized;
}

function activeTraceAttributes(): Record<string, string> {
  const carrier: Record<string, string> = {};
  propagation.inject(context.active(), carrier);
  const attributes: Record<string, string> = {};
  for (const key of ['traceparent', 'tracestate']) {
    const value = carrier[key];
    if (value) {
      attributes[key] = value;
    }
  }
  return attributes;
}

function toAttributeValues(
  attributes: Record<string, string>,
): Record<string, CloudEventAttributeValue> {
  const values: Record<string, CloudEventAttributeValue> = {};
  for (const [key, value] of Object.entries(attributes)) {
    values[key] = {ceString: value};
  }
  return values;
}

function toPublishMessageOptions(
  args: Record<string, unknown>,
  defaults: {
    toolConfig?: EventarcToolConfig;
    credentialsConfig?: EventarcCredentialsConfig;
  },
): PublishMessageOptions {
  return {
    ...defaults,
    bus: asString(args['bus']) ?? '',
    type: requireStringType(args['type'], ERROR_INVALID_TYPE) ?? '',
    source: requireStringType(args['source'], ERROR_INVALID_SOURCE) ?? '',
    data: args['data'],
    isBase64Encoded: args['is_base64_encoded'] === true,
    includeTracingExtension: args['include_tracing_extension'] === true,
    datacontenttype: asString(args['datacontenttype']),
    specversion: asString(args['specversion']),
    subject: asString(args['subject']),
    id: requireStringType(args['id'], ERROR_INVALID_ID),
    time: requireStringType(args['time'], ERROR_INVALID_TIME),
    customAttributes: requireRecordType(
      args['custom_attributes'],
      ERROR_INVALID_CUSTOM_ATTRIBUTES,
    ),
  };
}

/** Returns the value when it is a string, ignoring any other type. */
function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

/** Returns a present value only when it is a string, otherwise throws. */
function requireStringType(
  value: unknown,
  message: string,
): string | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== 'string') {
    throw new Error(message);
  }
  return value;
}

function requireRecordType(
  value: unknown,
  message: string,
): Record<string, unknown> | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (!isRecord(value)) {
    throw new Error(message);
  }
  return value;
}

/**
 * `FunctionTool` types the callback argument as `unknown` but always passes
 * its `Record<string, unknown>` argument bag, so the fallback only defends
 * untyped JavaScript callers that invoke the callback directly.
 */
function asRecord(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function errorResult(error: unknown): PublishMessageResult {
  return {status: 'ERROR', error_details: toErrorMessage(error)};
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
