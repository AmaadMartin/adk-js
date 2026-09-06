/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Session} from '../sessions/session.js';

/** Marks a display name whose three identifiers are base64url encoded. */
export const SOURCE_DISPLAY_NAME_PREFIX = 'adk-memory-v1.';

/** The session a RAG file was written for. */
export interface SourceIdentity {
  appName: string;
  userId: string;
  sessionId: string;
}

/** One line of a stored transcript. */
export interface TranscriptEvent {
  author: string;
  timestamp: number;
  text: string;
}

/** Encodes one identifier so that it cannot contain the `.` separator. */
function encodePart(value: string): string {
  return Buffer.from(value, 'utf-8').toString('base64url');
}

/**
 * Decodes one identifier, or returns `undefined` when `value` is not the exact
 * base64url encoding of a UTF-8 string.
 *
 * `Buffer` accepts padding, out-of-alphabet characters and non-canonical
 * trailing bits, dropping what it cannot use, so the re-encode test does the
 * rejecting.
 */
function decodePart(value: string): string | undefined {
  const bytes = Buffer.from(value, 'base64url');
  if (bytes.toString('base64url') !== value) {
    return undefined;
  }
  try {
    return new TextDecoder('utf-8', {fatal: true}).decode(bytes);
  } catch {
    return undefined;
  }
}

/** Builds the `displayName` of the RAG file holding a session's transcript. */
export function buildSourceDisplayName(identity: SourceIdentity): string {
  const parts = [identity.appName, identity.userId, identity.sessionId];
  return SOURCE_DISPLAY_NAME_PREFIX + parts.map(encodePart).join('.');
}

/**
 * Reads back the session a display name was built for, or returns `undefined`
 * when the name is not resolvable.
 *
 * Display names written before {@link SOURCE_DISPLAY_NAME_PREFIX} existed are
 * plain dot-delimited identifiers. Only their exact three-part form is
 * unambiguous, so a dotted app, user or session id is deliberately left
 * unresolvable rather than matched against the wrong tenant.
 */
export function parseSourceDisplayName(
  displayName: string,
): SourceIdentity | undefined {
  if (displayName.startsWith(SOURCE_DISPLAY_NAME_PREFIX)) {
    const encoded = displayName.slice(SOURCE_DISPLAY_NAME_PREFIX.length);
    const parts = encoded.split('.');
    if (parts.length !== 3) {
      return undefined;
    }
    const [appName, userId, sessionId] = parts.map(decodePart);
    if (
      appName === undefined ||
      userId === undefined ||
      sessionId === undefined
    ) {
      return undefined;
    }
    return {appName, userId, sessionId};
  }

  const parts = displayName.split('.');
  if (parts.length !== 3) {
    return undefined;
  }
  return {appName: parts[0], userId: parts[1], sessionId: parts[2]};
}

/**
 * Renders a session as one JSON object per line, which is what a RAG file
 * holds. Events carrying no text are left out.
 */
export function serializeSessionTranscript(session: Session): string {
  const lines: string[] = [];
  for (const event of session.events) {
    const texts = (event.content?.parts ?? [])
      .map((part) => part.text)
      .filter((text): text is string => !!text)
      .map((text) => text.replaceAll('\n', ' '));
    if (texts.length > 0) {
      lines.push(
        JSON.stringify({
          author: event.author,
          timestamp: event.timestamp,
          text: texts.join('.'),
        }),
      );
    }
  }
  return lines.join('\n');
}

/**
 * Reads the events out of a retrieved chunk.
 *
 * A chunk is a slice of a transcript, so its first and last lines can be
 * truncated. A line that does not parse is dropped and the rest of the chunk
 * is kept.
 */
export function parseTranscriptEvents(text: string): TranscriptEvent[] {
  const events: TranscriptEvent[] = [];
  for (const line of text.split('\n')) {
    const event = parseTranscriptLine(line.trim());
    if (event) {
      events.push(event);
    }
  }
  return events;
}

/** Parses one transcript line, or returns `undefined` when it is unusable. */
function parseTranscriptLine(line: string): TranscriptEvent | undefined {
  if (!line) {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (typeof parsed !== 'object' || parsed === null) {
    return undefined;
  }
  const record = parsed as Record<string, unknown>;
  const timestamp = Number(record['timestamp'] ?? 0);
  if (!Number.isFinite(timestamp)) {
    return undefined;
  }
  return {
    author: typeof record['author'] === 'string' ? record['author'] : '',
    timestamp,
    text: typeof record['text'] === 'string' ? record['text'] : '',
  };
}

/**
 * Collapses event lists that share a timestamp into one list.
 *
 * Retrieval returns overlapping chunks of the same transcript, so one turn
 * arrives more than once. Lists that share no timestamp describe different
 * stretches of the conversation and stay apart.
 */
export function mergeEventLists(
  eventLists: TranscriptEvent[][],
): TranscriptEvent[][] {
  const merged: TranscriptEvent[][] = [];
  let remaining = eventLists;
  while (remaining.length > 0) {
    const [first, ...rest] = remaining;
    const current = [...first];
    const timestamps = new Set(current.map((event) => event.timestamp));
    remaining = rest;
    // Absorbing a list can bring in timestamps that overlap a list already
    // passed over, so the scan repeats until nothing more is absorbed.
    let absorbedAny = true;
    while (absorbedAny) {
      const unmerged = absorbOverlapping(current, timestamps, remaining);
      absorbedAny = unmerged.length < remaining.length;
      remaining = unmerged;
    }
    merged.push(current);
  }
  return merged;
}

/**
 * Appends the events of every list overlapping `timestamps` to `current`, and
 * returns the lists that were left alone.
 */
function absorbOverlapping(
  current: TranscriptEvent[],
  timestamps: Set<number>,
  eventLists: TranscriptEvent[][],
): TranscriptEvent[][] {
  const unmerged: TranscriptEvent[][] = [];
  for (const other of eventLists) {
    if (!other.some((event) => timestamps.has(event.timestamp))) {
      unmerged.push(other);
      continue;
    }
    for (const event of other) {
      if (!timestamps.has(event.timestamp)) {
        timestamps.add(event.timestamp);
        current.push(event);
      }
    }
  }
  return unmerged;
}
