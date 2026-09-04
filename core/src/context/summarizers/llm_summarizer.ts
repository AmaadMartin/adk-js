/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {GenerateContentResponseUsageMetadata} from '@google/genai';
import {
  CompactedEvent,
  createCompactedEvent,
  isCompactedEvent,
} from '../../events/compacted_event.js';
import {Event} from '../../events/event.js';
import {BaseLlm} from '../../models/base_llm.js';
import {LlmRequest} from '../../models/llm_request.js';
import {BaseSummarizer} from './base_summarizer.js';

/** Options for constructing an {@link LlmSummarizer}. */
export interface LlmSummarizerOptions {
  /** The LLM instance used to generate the summary. */
  llm: BaseLlm;
  /**
   * Optional prompt template. When it contains the `{conversation_history}`
   * placeholder, the formatted history replaces the placeholder. Otherwise the
   * history is appended after the prompt. Defaults to a built-in
   * summarization prompt.
   */
  prompt?: string;
}

const HISTORY_PLACEHOLDER = '{conversation_history}';

const DEFAULT_PROMPT =
  'The following is a conversation history between a user and an AI agent.' +
  ' It may or may not start from a compacted history. Please identify and' +
  ' reiterate the user request, summarize the context so far, focusing on' +
  ' key decisions made and information obtained, as well as any unresolved' +
  ' questions or tasks. ' +
  'CRITICAL INSTRUCTIONS: ' +
  '1. Explicitly identify and state the primary language used by the user ' +
  'at the top of your summary (e.g., "Conversation Language: English"). ' +
  '2. If the agent called any tools, accurately list the exact tool names ' +
  'used to maintain tool grounding. ' +
  'The rest of the summary should be concise and capture the' +
  ` essence of the interaction.\n\n${HISTORY_PLACEHOLDER}`;

/**
 * Tool call arguments and responses can be large (e.g. search results). This
 * caps how much of each one is rendered, so compaction does not inflate the
 * very context it exists to shrink.
 */
const MAX_TOOL_CONTENT_CHARS = 2000;

/** Caps `text` at the tool-content limit, marking the dropped characters. */
function truncateToolContent(text: string): string {
  if (text.length <= MAX_TOOL_CONTENT_CHARS) {
    return text;
  }
  const dropped = text.length - MAX_TOOL_CONTENT_CHARS;
  return `${text.slice(0, MAX_TOOL_CONTENT_CHARS)}... [truncated ${dropped} chars]`;
}

/**
 * Formats events into prompt text, including thoughts and tool calls.
 *
 * Thoughts carry the agent's analysis of tool responses, and tool calls and
 * responses carry the evidence retrieved so far, so all three are included.
 * Thoughts emitted by a compaction event are skipped so a prior summary's
 * reasoning does not leak into the next summary.
 */
function formatEventsForPrompt(events: Event[]): string {
  const lines: string[] = [];
  for (const event of events) {
    if (!event.content?.parts?.length) {
      continue;
    }
    const isCompaction = isCompactedEvent(event);
    for (const part of event.content.parts) {
      if (part.thought && part.text) {
        if (!isCompaction) {
          lines.push(`${event.author} (thought): ${part.text}`);
        }
      } else if (part.text) {
        lines.push(`${event.author}: ${part.text}`);
      }
      if (part.functionCall) {
        const args = truncateToolContent(
          JSON.stringify(part.functionCall.args ?? {}),
        );
        lines.push(
          `${event.author} called tool: ${part.functionCall.name}(${args})`,
        );
      }
      if (part.functionResponse) {
        const response = truncateToolContent(
          JSON.stringify(part.functionResponse.response ?? {}),
        );
        lines.push(
          `Tool response from ${part.functionResponse.name}: ${response}`,
        );
      }
    }
  }
  return lines.join('\n');
}

/**
 * A summarizer that uses an LLM to generate a compacted representation
 * of existing events.
 */
export class LlmSummarizer implements BaseSummarizer {
  private readonly llm: BaseLlm;
  private readonly prompt: string;

  /**
   * @param options - Configuration specifying the LLM and optional prompt.
   */
  constructor(options: LlmSummarizerOptions) {
    this.llm = options.llm;
    this.prompt = options.prompt || DEFAULT_PROMPT;
  }

  /**
   * Summarizes a list of events into a single {@link CompactedEvent} using the
   * configured LLM.
   *
   * @param events - The events to summarize.
   * @returns A promise resolving to the compacted representation, or `null`
   *     when `events` is empty or the LLM returns no content.
   */
  async summarize(events: Event[]): Promise<CompactedEvent | null> {
    if (events.length === 0) {
      return null;
    }

    const conversationHistory = formatEventsForPrompt(events);
    // The replacement must be a function: a string replacement expands `$&`
    // and friends, which conversation text can contain.
    const prompt = this.prompt.includes(HISTORY_PLACEHOLDER)
      ? this.prompt.replaceAll(HISTORY_PLACEHOLDER, () => conversationHistory)
      : `${this.prompt}\n\n${conversationHistory}`;

    const request: LlmRequest = {
      model: this.llm.model,
      contents: [{role: 'user', parts: [{text: prompt}]}],
      toolsDict: {},
      liveConnectConfig: {},
    };

    let compactedContent = '';
    let usageMetadata: GenerateContentResponseUsageMetadata | undefined;
    for await (const response of this.llm.generateContentAsync(
      request,
      false,
    )) {
      const parts = response.content?.parts;
      if (!parts) {
        continue;
      }
      for (const part of parts) {
        if (part.text) {
          compactedContent += part.text;
        }
      }
      usageMetadata = response.usageMetadata ?? usageMetadata;
    }

    if (!compactedContent) {
      return null;
    }

    return createCompactedEvent({
      author: 'user',
      content: {
        role: 'model',
        parts: [{text: compactedContent}],
      },
      startTime: events[0].timestamp,
      endTime: events[events.length - 1].timestamp,
      compactedContent,
      usageMetadata,
    });
  }
}
