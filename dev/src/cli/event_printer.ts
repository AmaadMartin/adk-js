/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  Event,
  getUserInputRequests,
  UserInputKind,
  UserInputRequest,
} from '@google/adk';
import {isRecord} from '../utils/value_utils.js';

const HOW_TO_ANSWER: Record<UserInputKind, string> = {
  input: 'Type your reply at the next prompt to continue.',
  credential: 'Type the credential at the next prompt to continue.',
  confirmation: "Reply 'yes' to approve or 'no' to reject.",
};

/** Keys pulled to the front of a JSONL record, for readability in a viewer. */
const JSONL_LEADING_KEYS = ['author', 'session_id', 'node_path', 'id'];

/**
 * Formatting only — detection lives in `getUserInputRequests`. This decides how
 * the CLI words a pause and how the user is told to answer it.
 */
export function renderUserInputRequest(request: UserInputRequest): string {
  const author = request.author ?? 'agent';
  const lines: string[] = [];

  switch (request.kind) {
    case 'input':
      lines.push(`--- [${author}] is waiting for your input ---`);
      break;
    case 'credential':
      lines.push(`--- [${author}] is waiting for a credential ---`);
      break;
    case 'confirmation':
      lines.push(
        `--- [${author}] is waiting for confirmation ---` +
          (request.toolName ? `\nTool: ${request.toolName}` : ''),
      );
      break;
    default:
      break;
  }

  if (request.message) {
    lines.push(request.message);
  }
  if (request.payload != null) {
    lines.push(`Payload: ${JSON.stringify(request.payload)}`);
  }
  if (request.responseSchema != null) {
    lines.push(`Expected response: ${JSON.stringify(request.responseSchema)}`);
  }

  const scheme = request.authConfig?.authScheme as
    | {type?: string; in?: string; name?: string}
    | undefined;
  if (scheme?.type) {
    const where =
      scheme.in && scheme.name ? ` (${scheme.in} ${scheme.name})` : '';
    lines.push(`Auth scheme: ${scheme.type}${where}`);
  }

  lines.push(HOW_TO_ANSWER[request.kind]);

  return lines.join('\n');
}

/** Options controlling how one event is rendered. */
export interface PrintEventOptions {
  /**
   * Whether to announce the pauses this event raised. Off when replaying a
   * saved transcript, where a pause shown per event would re-ask questions the
   * user already answered; the still-open ones are printed once afterwards.
   */
  announcePauses?: boolean;
  /** Emit one JSON object per line instead of human-readable text. */
  jsonl?: boolean;
  /** Session id injected into each JSONL record. */
  sessionId?: string;
}

/**
 * Renders a node output for the transcript: a string as itself, anything else
 * as JSON. The empty string is named rather than printed.
 */
function renderOutput(output: unknown): string {
  if (typeof output === 'string') {
    return output === '' ? '(empty response)' : output;
  }
  try {
    return JSON.stringify(output) ?? String(output);
  } catch {
    return String(output);
  }
}

function isEmptyObject(value: unknown): boolean {
  return isRecord(value) && Object.keys(value).length === 0;
}

/** Reorders a record so `leading` keys, where present, come first. */
function reorderKeys(
  record: Record<string, unknown>,
  leading: string[],
): Record<string, unknown> {
  const ordered: Record<string, unknown> = {};
  for (const key of leading) {
    if (key in record) {
      ordered[key] = record[key];
    }
  }
  return {...ordered, ...record};
}

/**
 * Builds the JSONL record for an event: the event itself, with `undefined`
 * dropped, the session id and node path added, and the empty sub-objects of
 * `actions` removed so the line stays readable.
 */
export function toJsonlRecord(
  event: Event,
  sessionId?: string,
): Record<string, unknown> {
  const parsed: unknown = JSON.parse(JSON.stringify(event));
  const record: Record<string, unknown> = isRecord(parsed) ? parsed : {};

  if (sessionId) {
    record['session_id'] = sessionId;
  }
  if (event.nodeInfo?.path) {
    record['node_path'] = event.nodeInfo.path;
  }

  const actions = record['actions'];
  if (isRecord(actions)) {
    const kept = Object.entries(actions).filter(
      ([, value]) => !isEmptyObject(value),
    );
    if (kept.length === 0) {
      delete record['actions'];
    } else {
      record['actions'] = Object.fromEntries(kept);
    }
  }

  return reorderKeys(record, JSONL_LEADING_KEYS);
}

/** Prints one event's text, plus anything the user would otherwise not see. */
export function printEvent(
  event: Event,
  options: PrintEventOptions = {},
): void {
  const {announcePauses = true, jsonl = false, sessionId} = options;

  if (jsonl) {
    console.log(JSON.stringify(toJsonlRecord(event, sessionId)));
    return;
  }

  const author = event.author ?? 'agent';

  const text = (event.content?.parts ?? [])
    .map((part) => part.text || '')
    .join('');
  if (text) {
    console.log(`[${author}]: ${text}`);
  } else if (event.output !== undefined && !event.partial) {
    console.log(`[${author}]: ${renderOutput(event.output)}`);
  }

  // Reported on the event, not as a text part, so text-only printing drops it.
  if (event.errorCode || event.errorMessage) {
    const detail = [event.errorCode, event.errorMessage]
      .filter(Boolean)
      .join(': ');
    console.error(`[${author}] error: ${detail}`);
  }

  if (!announcePauses) {
    return;
  }

  for (const request of getUserInputRequests(event)) {
    console.log(renderUserInputRequest(request));
  }
}
