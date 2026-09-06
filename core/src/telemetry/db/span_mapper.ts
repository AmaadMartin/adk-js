/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {EntityData} from '@mikro-orm/core';
import {
  Attributes,
  AttributeValue,
  HrTime,
  SpanContext,
  SpanKind,
  SpanStatusCode,
  TraceFlags,
} from '@opentelemetry/api';
import {emptyResource} from '@opentelemetry/resources';
import {ReadableSpan} from '@opentelemetry/sdk-trace-base';

import {logger} from '../../utils/logger.js';
import {version} from '../../version.js';
import {StorageSpan} from './schema.js';

const SESSION_ID_ATTRIBUTE = 'gcp.vertex.agent.session_id';
const INVOCATION_ID_ATTRIBUTE = 'gcp.vertex.agent.invocation_id';
const CONVERSATION_ID_ATTRIBUTE = 'gen_ai.conversation.id';

const INSTRUMENTATION_SCOPE_NAME = 'gcp.vertex.agent';
const NANOS_PER_SECOND = 1_000_000_000n;

/** Converts an OpenTelemetry `HrTime` to epoch nanoseconds. */
export function hrTimeToUnixNanos(hrTime: HrTime): string {
  return (BigInt(hrTime[0]) * NANOS_PER_SECOND + BigInt(hrTime[1])).toString();
}

/**
 * Serializes span attributes to JSON, falling back to an empty object.
 *
 * A payload that was already unserializable upstream arrives as the
 * `'<not serializable>'` string that `tracing.ts` substitutes for it, so the
 * fallback here only guards a value that is not a real `AttributeValue`.
 */
export function serializeAttributes(
  attributes: Record<string, unknown>,
): string {
  try {
    return JSON.stringify(attributes);
  } catch (e: unknown) {
    logger.debug('Failed to serialize span attributes:', e);
    return '{}';
  }
}

/**
 * Parses a stored attributes blob back into OpenTelemetry attributes.
 *
 * Never throws: malformed JSON and non-object payloads yield `{}`, and entries
 * whose value is not a legal `AttributeValue` are dropped.
 */
export function deserializeAttributes(
  attributesJson: string | undefined,
): Attributes {
  if (!attributesJson) {
    return {};
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(attributesJson);
  } catch (e: unknown) {
    logger.debug('Failed to deserialize span attributes:', e);
    return {};
  }

  if (!isRecord(parsed)) {
    return {};
  }

  const attributes: Attributes = {};
  for (const [key, value] of Object.entries(parsed)) {
    if (isAttributeValue(value)) {
      attributes[key] = value;
    }
  }
  return attributes;
}

/** Orders stored spans oldest first. */
export function compareByStartTime(a: StorageSpan, b: StorageSpan): number {
  const delta = toNanos(a.startTimeUnixNano) - toNanos(b.startTimeUnixNano);
  if (delta === 0n) {
    return 0;
  }
  return delta < 0n ? -1 : 1;
}

/** Maps a finished span to the row that persists it. */
export function toStorageSpanData(span: ReadableSpan): EntityData<StorageSpan> {
  const spanContext = span.spanContext();
  return {
    spanId: spanContext.spanId,
    traceId: spanContext.traceId,
    parentSpanId: span.parentSpanContext?.spanId,
    name: span.name,
    startTimeUnixNano: hrTimeToUnixNanos(span.startTime),
    endTimeUnixNano: hrTimeToUnixNanos(span.endTime),
    // `||`, not `??`: the reference falls through on an empty session id too.
    sessionId:
      stringAttribute(span.attributes, SESSION_ID_ATTRIBUTE) ||
      stringAttribute(span.attributes, CONVERSATION_ID_ATTRIBUTE),
    invocationId: stringAttribute(span.attributes, INVOCATION_ID_ATTRIBUTE),
    attributesJson: serializeAttributes(span.attributes),
  };
}

/** Reconstructs a readable span from the row that persisted it. */
export function toReadableSpan(row: StorageSpan): ReadableSpan {
  const spanContext: SpanContext = {
    traceId: row.traceId,
    spanId: row.spanId,
    traceFlags: TraceFlags.SAMPLED,
    isRemote: false,
  };
  const startNanos = toNanos(row.startTimeUnixNano);
  const endNanos = toNanos(row.endTimeUnixNano);

  return {
    name: row.name,
    kind: SpanKind.INTERNAL,
    spanContext: () => spanContext,
    parentSpanContext: row.parentSpanId
      ? {...spanContext, spanId: row.parentSpanId}
      : undefined,
    startTime: nanosToHrTime(startNanos),
    endTime: nanosToHrTime(endNanos),
    duration: nanosToHrTime(endNanos - startNanos),
    status: {code: SpanStatusCode.UNSET},
    attributes: deserializeAttributes(row.attributesJson),
    links: [],
    events: [],
    ended: true,
    resource: emptyResource(),
    instrumentationScope: {name: INSTRUMENTATION_SCOPE_NAME, version},
    droppedAttributesCount: 0,
    droppedEventsCount: 0,
    droppedLinksCount: 0,
  };
}

function nanosToHrTime(total: bigint): HrTime {
  return [Number(total / NANOS_PER_SECOND), Number(total % NANOS_PER_SECOND)];
}

/** Reads a stored timestamp, treating a missing one as the epoch. */
function toNanos(stored: string | undefined): bigint {
  return BigInt(stored ?? '0');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isAttributePrimitive(
  value: unknown,
): value is string | number | boolean {
  const type = typeof value;
  return type === 'string' || type === 'number' || type === 'boolean';
}

function isAttributeValue(value: unknown): value is AttributeValue {
  if (isAttributePrimitive(value)) {
    return true;
  }
  if (!Array.isArray(value)) {
    return false;
  }
  const present = value.filter((entry) => entry != null);
  const [first] = present;
  return present.every(
    (entry) => typeof entry === typeof first && isAttributePrimitive(entry),
  );
}

function stringAttribute(
  attributes: Attributes,
  key: string,
): string | undefined {
  const value = attributes[key];
  return typeof value === 'string' ? value : undefined;
}
