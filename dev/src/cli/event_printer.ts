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
import {writeJsonlRecord} from './jsonl_stdout.js';

const HOW_TO_ANSWER: Record<UserInputKind, string> = {
  input: 'Type your reply at the next prompt to continue.',
  credential: 'Type the credential at the next prompt to continue.',
  confirmation: "Reply 'yes' to approve or 'no' to reject.",
};

/**
 * The keys a JSONL reader looks at first, in the order adk-python writes them.
 * `session_id` and `node_path` keep their snake_case spelling because they are
 * the literal keys on the wire.
 */
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

/** Options for {@link printEvent}. */
export interface PrintEventOptions {
  /**
   * Whether to announce the pauses this event raised. Off when replaying a
   * saved transcript, where a pause shown per event would re-ask questions the
   * user already answered; the still-open ones are printed once afterwards.
   */
  announcePauses?: boolean;

  /** Whether to write the event as one JSON line instead of readable text. */
  jsonl?: boolean;

  /** The session the event belongs to, injected into the JSONL record. */
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

/** Whether the value is an object carrying nothing, e.g. an unused delta. */
function isEmptyObject(value: unknown): boolean {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    Object.keys(value).length === 0
  );
}

/**
 * Builds the JSONL record for an event.
 *
 * Every action map defaults to `{}`, so an ordinary event would otherwise carry
 * four empty objects per line; those are dropped, and `actions` with them once
 * nothing is left.
 */
function toJsonlRecord(
  event: Event,
  sessionId?: string,
): Record<string, unknown> {
  const {actions, ...rest} = event;
  const record: Record<string, unknown> = {...rest};

  if (sessionId) {
    record['session_id'] = sessionId;
  }
  if (event.nodeInfo?.path) {
    record['node_path'] = event.nodeInfo.path;
  }

  // `actions` is declared required, but an event handed straight to the
  // printer by a caller that built it by hand may still omit it, and printing
  // must not be what fails the run.
  const keptActions = Object.fromEntries(
    Object.entries(actions ?? {}).filter(([, value]) => !isEmptyObject(value)),
  );
  if (Object.keys(keptActions).length > 0) {
    record['actions'] = keptActions;
  }

  const ordered: Record<string, unknown> = {};
  for (const key of JSONL_LEADING_KEYS) {
    if (key in record) {
      ordered[key] = record[key];
    }
  }
  for (const [key, value] of Object.entries(record)) {
    if (!(key in ordered)) {
      ordered[key] = value;
    }
  }
  return ordered;
}

/** Prints one event's text, plus anything the user would otherwise not see. */
export function printEvent(
  event: Event,
  options: PrintEventOptions = {},
): void {
  if (options.jsonl) {
    writeJsonlRecord(JSON.stringify(toJsonlRecord(event, options.sessionId)));
    return;
  }

  const {announcePauses = true} = options;
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
