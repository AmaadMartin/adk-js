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
 * This is the canonical wire shape every ADK SDK writes.
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
 * `startTime` and `endTime` are copied verbatim from the payload. adk-js event
 * timestamps are milliseconds and adk-python's are seconds, so each SDK writes
 * its own unit into these fields; converting here would corrupt every adk-js
 * session, and a reader only compares a compaction's bounds against timestamps
 * from the same session.
 */
export interface ParsedCompactionMetadata {
  startTime: number;
  endTime: number;
  compactedContent: string;
  /** The summary as a `Content`, absent for the legacy adk-js payload. */
  content?: Content;
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
    start_timestamp: event.startTime,
    end_timestamp: event.endTime,
    compacted_content: toContent(event),
  };
}

/** Builds the alias payload for `rawEvent.actions.compaction`. */
export function toAliasedCompactionMetadata(
  event: CompactedEvent,
): AliasedCompactionMetadata {
  return {
    startTimestamp: event.startTime,
    endTimestamp: event.endTime,
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
  if (isRecord(value)) {
    const canonical = parseContentPayload(
      value,
      'start_timestamp',
      'end_timestamp',
      'compacted_content',
    );
    if (canonical) {
      return canonical;
    }
    const aliased = parseContentPayload(
      value,
      'startTimestamp',
      'endTimestamp',
      'compactedContent',
    );
    if (aliased) {
      return aliased;
    }
    const legacy = parseTimestamps(value, 'startTime', 'endTime');
    if (legacy && typeof value['compactedContent'] === 'string') {
      return {...legacy, compactedContent: value['compactedContent']};
    }
  }
  logger.debug('Dropping an unrecognized compaction payload.');
  return undefined;
}

function parseContentPayload(
  value: Record<string, unknown>,
  startKey: string,
  endKey: string,
  contentKey: string,
): ParsedCompactionMetadata | undefined {
  const timestamps = parseTimestamps(value, startKey, endKey);
  const content = value[contentKey];
  if (!timestamps || !isContent(content)) {
    return undefined;
  }
  return {...timestamps, compactedContent: flattenContent(content), content};
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
