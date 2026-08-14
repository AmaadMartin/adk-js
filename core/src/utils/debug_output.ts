/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type {Part} from '@google/genai';

import type {Event} from '../events/event.js';

import {logger} from './logger.js';

/** Rendered length cap for a function call's arguments. */
const ARGS_MAX_LEN = 50;

/** Rendered length cap for a function response. */
const RESPONSE_MAX_LEN = 100;

/** Rendered length cap for a code execution's output. */
const CODE_OUTPUT_MAX_LEN = 100;

function truncate(text: string, maxLen: number): string {
  return text.length > maxLen ? `${text.slice(0, maxLen)}...` : text;
}

/**
 * Renders the bracketed summary of a single non-text part.
 *
 * The branch order is observable: a part that carries more than one of these
 * fields renders as the first branch it matches. The order mirrors the
 * `if`/`elif` chain in `google/adk-python`
 * `src/google/adk/utils/_debug_output.py`.
 *
 * @param part The part to summarise.
 * @return The summary, or undefined when the part carries none of the fields.
 */
function formatNonTextPart(part: Part): string | undefined {
  if (part.functionCall) {
    const args = truncate(
      JSON.stringify(part.functionCall.args ?? {}),
      ARGS_MAX_LEN,
    );
    return `[Calling tool: ${part.functionCall.name}(${args})]`;
  }
  if (part.functionResponse) {
    const response = truncate(
      JSON.stringify(part.functionResponse.response ?? {}),
      RESPONSE_MAX_LEN,
    );
    return `[Tool result: ${response}]`;
  }
  if (part.executableCode) {
    return `[Executing ${part.executableCode.language ?? 'code'} code...]`;
  }
  if (part.codeExecutionResult) {
    const output = truncate(
      part.codeExecutionResult.output ?? 'result',
      CODE_OUTPUT_MAX_LEN,
    );
    return `[Code output: ${output}]`;
  }
  if (part.inlineData) {
    return `[Inline data: ${part.inlineData.mimeType ?? 'data'}]`;
  }
  if (part.fileData) {
    return `[File: ${part.fileData.fileUri ?? 'file'}]`;
  }
  return undefined;
}

/**
 * Renders an event as human-readable transcript lines.
 *
 * Text parts always render. Consecutive text parts within one event are joined
 * into a single line so the author prefix is not repeated. Non-text parts
 * render only when `verbose` is set.
 *
 * The author prefix falls back to the empty string, matching the `author: str
 * = ''` default of `Event` in `google/adk-python`.
 *
 * @param event The event to render.
 * @param options.verbose Adds tool call, tool result and code execution lines.
 * @return The rendered lines, empty when the event shows nothing.
 */
export function formatEventLines(
  event: Event,
  options: {verbose?: boolean} = {},
): string[] {
  const parts = event.content?.parts;
  if (!parts?.length) {
    return [];
  }

  const author = event.author ?? '';
  const lines: string[] = [];
  let textBuffer = '';

  for (const part of parts) {
    if (part.text) {
      textBuffer += part.text;
      continue;
    }

    if (textBuffer) {
      lines.push(`${author} > ${textBuffer}`);
      textBuffer = '';
    }

    if (!options.verbose) {
      continue;
    }

    const summary = formatNonTextPart(part);
    if (summary) {
      lines.push(`${author} > ${summary}`);
    }
  }

  if (textBuffer) {
    lines.push(`${author} > ${textBuffer}`);
  }

  return lines;
}

/**
 * Emits an event as human-readable transcript lines through the ADK logger.
 *
 * @param event The event to emit.
 * @param options.verbose Adds tool call, tool result and code execution lines.
 */
export function printEvent(
  event: Event,
  options: {verbose?: boolean} = {},
): void {
  for (const line of formatEventLines(event, options)) {
    logger.info(line);
  }
}
