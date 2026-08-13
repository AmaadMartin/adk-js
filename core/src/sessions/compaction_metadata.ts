/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Content, createModelContent} from '@google/genai';

import {CompactedEvent} from '../events/compacted_event.js';
import {logger} from '../utils/logger.js';

/**
 * The `_compaction` payload as adk-python persists it under
 * `eventMetadata.customMetadata`.
 *
 * adk-python dumps `EventCompaction` without `by_alias`, so the persisted keys
 * are the model's snake_case field names and the summary is a full `Content`.
 * This is the canonical wire shape every ADK SDK writes. Its timestamps are
 * seconds.
 */
export interface CompactionMetadata {
  start_timestamp: number;
  end_timestamp: number;
  compacted_content: Content;
}

/**
 * The same payload under adk-python's camelCase aliases.
 *
 * adk-python dumps the whole event with `by_alias=True` into `rawEvent`, so the
 * mirror at `rawEvent.actions.compaction` uses the alias spelling.
 */
export interface AliasedCompactionMetadata {
  startTimestamp: number;
  endTimestamp: number;
  compactedContent: Content;
}

/**
 * The compaction fields a {@link CompactedEvent} is rebuilt from.
 *
 * `startTime` and `endTime` are milliseconds, the unit of an adk-js
 * `Event.timestamp`.
 */
export interface ParsedCompactionMetadata {
  startTime: number;
  endTime: number;
  compactedContent: string;
  /** The summary as a `Content`, absent for the legacy adk-js payload. */
  content?: Content;
}

/**
 * `EventCompaction` declares its timestamps in seconds and adk-js measures an
 * `Event.timestamp` in milliseconds, so the canonical payload is scaled on both
 * sides. Both SDKs compare a compaction's bounds against raw event timestamps —
 * `getActiveEvents` here, `_is_timestamp_compacted` and the compaction
 * candidate filter in adk-python — so a payload in the wrong unit is restored
 * but never matches anything.
 *
 * The historical adk-js payload keeps its milliseconds: adk-js wrote its own
 * event timestamps into those keys, and rescaling them would break the sessions
 * that already hold them.
 */
const MILLISECONDS_PER_SECOND = 1000;

/**
 * Rounds because an adk-python timestamp carries microseconds, and an adk-js
 * `Event.timestamp` is a whole number of milliseconds.
 */
function toEventMilliseconds(seconds: number): number {
  return Math.round(seconds * MILLISECONDS_PER_SECOND);
}

function toWireSeconds(milliseconds: number): number {
  return milliseconds / MILLISECONDS_PER_SECOND;
}

/**
 * Prefers the event's own `Content` so a multi-part or non-text summary is not
 * flattened on write, and gives a synthesized one the `model` role, as
 * adk-python's summarizer does.
 */
function toContent(event: CompactedEvent): Content {
  return event.content ?? createModelContent(event.compactedContent);
}

/** Builds the canonical payload for `customMetadata._compaction`. */
export function toCompactionMetadata(
  event: CompactedEvent,
): CompactionMetadata {
  return {
    start_timestamp: toWireSeconds(event.startTime),
    end_timestamp: toWireSeconds(event.endTime),
    compacted_content: toContent(event),
  };
}

/** Builds the alias payload for `rawEvent.actions.compaction`. */
export function toAliasedCompactionMetadata(
  event: CompactedEvent,
): AliasedCompactionMetadata {
  return {
    startTimestamp: toWireSeconds(event.startTime),
    endTimestamp: toWireSeconds(event.endTime),
    compactedContent: toContent(event),
  };
}

/**
 * Parses any accepted `_compaction` spelling into the fields a
 * {@link CompactedEvent} needs.
 *
 * Accepted, in precedence order: the canonical snake_case payload, its
 * camelCase alias, and the historical adk-js payload whose `compactedContent`
 * is a flat string. The historical spelling stays accepted permanently so
 * sessions written by earlier adk-js versions keep their compaction.
 *
 * Returns `undefined` for anything else, which leaves the event non-compacted.
 * A partially populated `CompactedEvent` is worse than none: it renders the
 * summary as `undefined` and hides every event from the active window.
 */
export function parseCompactionMetadata(
  value: unknown,
): ParsedCompactionMetadata | undefined {
  const parsed = parsePayload(value);
  // An empty summary is a payload this reader cannot use: it renders as a bare
  // context header and still hides every event the compaction covered.
  if (parsed && parsed.compactedContent !== '') {
    return parsed;
  }
  logger.debug('Dropping a compaction payload with no readable summary.');
  return undefined;
}

function parsePayload(value: unknown): ParsedCompactionMetadata | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  return (
    parseCanonicalPayload(
      value,
      'start_timestamp',
      'end_timestamp',
      'compacted_content',
    ) ??
    parseCanonicalPayload(
      value,
      'startTimestamp',
      'endTimestamp',
      'compactedContent',
    ) ??
    parseLegacyPayload(value)
  );
}

/** Parses the canonical payload or its alias, whose timestamps are seconds. */
function parseCanonicalPayload(
  value: Record<string, unknown>,
  startKey: string,
  endKey: string,
  contentKey: string,
): ParsedCompactionMetadata | undefined {
  const seconds = parseTimestamps(value, startKey, endKey);
  const content = value[contentKey];
  if (!seconds || !isContent(content)) {
    return undefined;
  }
  return {
    startTime: toEventMilliseconds(seconds.startTime),
    endTime: toEventMilliseconds(seconds.endTime),
    compactedContent: flattenContent(content),
    content,
  };
}

/** Parses the historical adk-js payload, whose timestamps are milliseconds. */
function parseLegacyPayload(
  value: Record<string, unknown>,
): ParsedCompactionMetadata | undefined {
  const milliseconds = parseTimestamps(value, 'startTime', 'endTime');
  const compactedContent = value['compactedContent'];
  if (!milliseconds || typeof compactedContent !== 'string') {
    return undefined;
  }
  return {...milliseconds, compactedContent};
}

function parseTimestamps(
  value: Record<string, unknown>,
  startKey: string,
  endKey: string,
): {startTime: number; endTime: number} | undefined {
  const startTime = value[startKey];
  const endTime = value[endKey];
  if (typeof startTime !== 'number' || typeof endTime !== 'number') {
    return undefined;
  }
  return {startTime, endTime};
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * A `Content` has only optional fields, so the check is structural: an object
 * whose `parts`, when present, is an array. The string form belongs to the
 * legacy adk-js payload and must not be read as a `Content`, or a mixed payload
 * flattens to `[object Object]`.
 */
function isContent(value: unknown): value is Content {
  return (
    isRecord(value) &&
    (value['parts'] === undefined || Array.isArray(value['parts']))
  );
}

function flattenContent(content: Content): string {
  return (content.parts ?? []).map((part) => part.text ?? '').join('');
}
