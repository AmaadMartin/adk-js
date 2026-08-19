/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  Part as A2APart,
  FilePart,
  FileWithBytes,
  FileWithUri,
  Message,
} from '@a2a-js/sdk';
import {
  A2AEvent,
  isMessage,
  isTask,
  isTaskStatusUpdateEvent,
} from './a2a_event.js';

const SEPARATOR = '-'.repeat(59);
const NESTED_INDENT = '  ';
const PART_METADATA_INDENT = '    ';
const MAX_TEXT_LENGTH = 100;
const MAX_DATA_VALUE_LENGTH = 100;
const REDACTED_FILE_BYTES = '<bytes redacted>';
const UNSERIALIZABLE = '<unserializable>';

/**
 * Labels used for the `Result Type` line of a response log.
 */
const RESULT_TYPE_LABELS: Record<A2AEvent['kind'], string> = {
  'task': 'Task',
  'message': 'Message',
  'status-update': 'TaskStatusUpdateEvent',
  'artifact-update': 'TaskArtifactUpdateEvent',
};

/**
 * Re-indents the continuation lines of a multi-line block.
 */
function indentLines(text: string, indent: string): string {
  return text.split('\n').join(`\n${indent}`);
}

function hasEntries(
  record: Record<string, unknown> | undefined,
): record is Record<string, unknown> {
  return !!record && Object.keys(record).length > 0;
}

/**
 * Renders a labelled metadata block, or `undefined` when there is nothing to
 * render, so callers can omit the section with a single check.
 */
function formatMetadata(
  metadata: Record<string, unknown> | undefined,
  indent: string,
  label = 'Metadata',
): string | undefined {
  if (!hasEntries(metadata)) {
    return undefined;
  }
  const json = indentLines(JSON.stringify(metadata, null, 2), indent);
  return `${indent}${label}:\n${indent}${json}`;
}

/**
 * Replaces data values that are too large to read with a placeholder.
 */
function summarizeDataValue(value: unknown): unknown {
  if (value === null || typeof value !== 'object') {
    return value;
  }
  if (JSON.stringify(value).length <= MAX_DATA_VALUE_LENGTH) {
    return value;
  }
  return Array.isArray(value) ? '<array>' : '<object>';
}

/**
 * Renders a file part with its base64 payload redacted, so binary content
 * never reaches the log.
 */
function buildFilePartLog(part: FilePart): string {
  const file: FileWithBytes | FileWithUri =
    'bytes' in part.file
      ? {...part.file, bytes: REDACTED_FILE_BYTES}
      : part.file;
  try {
    return `FilePart: ${JSON.stringify({kind: part.kind, file})}`;
  } catch {
    return `FilePart: ${UNSERIALIZABLE}`;
  }
}

function buildPartContentLog(part: A2APart): string {
  switch (part.kind) {
    case 'text': {
      const ellipsis = part.text.length > MAX_TEXT_LENGTH ? '...' : '';
      return `TextPart: ${part.text.slice(0, MAX_TEXT_LENGTH)}${ellipsis}`;
    }
    case 'data': {
      const summary = Object.fromEntries(
        Object.entries(part.data).map(([key, value]) => [
          key,
          summarizeDataValue(value),
        ]),
      );
      return `DataPart: ${JSON.stringify(summary, null, 2)}`;
    }
    case 'file':
      return buildFilePartLog(part);
  }
}

/**
 * Builds a log representation of a single A2A message part.
 *
 * @param part - The A2A part to render.
 * @returns A human-readable representation of the part. Long text is
 *   truncated, large data values are summarized and file bytes are redacted.
 */
export function buildMessagePartLog(part: A2APart): string {
  const content = buildPartContentLog(part);
  if (!hasEntries(part.metadata)) {
    return content;
  }
  const json = indentLines(
    JSON.stringify(part.metadata, null, 2),
    PART_METADATA_INDENT,
  );
  return `${content}\n${PART_METADATA_INDENT}Part Metadata: ${json}`;
}

/**
 * Renders the numbered `Part i:` block of a message, indenting each part's
 * continuation lines so a multi-part message stays readable.
 */
function buildPartsLog(parts: A2APart[], indent: string): string {
  if (parts.length === 0) {
    return `${indent}No parts`;
  }
  const contentIndent = indent + NESTED_INDENT;
  return parts
    .map(
      (part, i) =>
        `${indent}Part ${i}: ${indentLines(buildMessagePartLog(part), contentIndent)}`,
    )
    .join('\n');
}

function buildMessageFieldsLog(message: Message, indent: string): string {
  return [
    `${indent}ID: ${message.messageId}`,
    `${indent}Role: ${message.role}`,
    `${indent}Task ID: ${message.taskId}`,
    `${indent}Context ID: ${message.contextId}`,
  ].join('\n');
}

function buildMessageLog(message: Message, indent: string): string {
  const sections = [
    buildMessageFieldsLog(message, indent),
    `${indent}Message Parts:`,
    buildPartsLog(message.parts, indent),
  ];
  const metadata = formatMetadata(message.metadata, indent);
  if (metadata) {
    sections.push(metadata);
  }
  return sections.join('\n');
}

/**
 * Builds a structured log representation of an outgoing A2A request.
 *
 * @param req - The A2A message that is about to be sent.
 * @returns A formatted, multi-line representation of the request.
 */
export function buildA2ARequestLog(req: Message): string {
  const metadata = formatMetadata(req.metadata, NESTED_INDENT);
  const metadataSection = metadata ? `\n${metadata}` : '';
  return `
A2A Send Message Request:
${SEPARATOR}
Message:
${buildMessageFieldsLog(req, NESTED_INDENT)}${metadataSection}
${SEPARATOR}
Message Parts:
${buildPartsLog(req.parts, '')}
${SEPARATOR}
`;
}

function buildResultDetailsLog(resp: A2AEvent): string {
  if (isTask(resp)) {
    const details = [
      `Task ID: ${resp.id}`,
      `Context ID: ${resp.contextId}`,
      `Status State: ${resp.status.state}`,
      `Status Timestamp: ${resp.status.timestamp}`,
      `History Length: ${resp.history?.length ?? 0}`,
      `Artifacts Count: ${resp.artifacts?.length ?? 0}`,
    ];
    const metadata = formatMetadata(resp.metadata, '', 'Task Metadata');
    if (metadata) {
      details.push(metadata);
    }
    return details.join('\n');
  }

  if (isMessage(resp)) {
    return buildMessageLog(resp, NESTED_INDENT);
  }

  if (isTaskStatusUpdateEvent(resp)) {
    return [
      `Task ID: ${resp.taskId}`,
      `Context ID: ${resp.contextId}`,
      `Status State: ${resp.status.state}`,
      `Final: ${resp.final}`,
    ].join('\n');
  }

  return [
    `Task ID: ${resp.taskId}`,
    `Context ID: ${resp.contextId}`,
    `Artifact ID: ${resp.artifact.artifactId}`,
    `Parts Count: ${resp.artifact.parts.length}`,
  ].join('\n');
}

function buildStatusMessageLog(resp: A2AEvent): string {
  const message =
    isTask(resp) || isTaskStatusUpdateEvent(resp)
      ? resp.status.message
      : undefined;
  return message ? buildMessageLog(message, '') : 'None';
}

function buildHistoryLog(resp: A2AEvent): string {
  if (!isTask(resp) || !resp.history?.length) {
    return 'No history';
  }
  return resp.history
    .map(
      (message, i) =>
        `Message ${i + 1}:\n${buildMessageLog(message, NESTED_INDENT)}`,
    )
    .join('\n');
}

/**
 * Builds a structured log representation of an inbound A2A stream event.
 *
 * @param resp - The A2A event received from the remote agent.
 * @returns A formatted, multi-line representation of the event.
 */
export function buildA2AResponseLog(resp: A2AEvent): string {
  return `
A2A Response:
${SEPARATOR}
Result Type: ${RESULT_TYPE_LABELS[resp.kind]}
${SEPARATOR}
Result Details:
${buildResultDetailsLog(resp)}
${SEPARATOR}
Status Message:
${buildStatusMessageLog(resp)}
${SEPARATOR}
History:
${buildHistoryLog(resp)}
${SEPARATOR}
`;
}
