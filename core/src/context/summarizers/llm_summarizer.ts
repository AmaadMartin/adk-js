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

/** Marks where the formatted conversation goes in a summarization prompt. */
const CONVERSATION_HISTORY_PLACEHOLDER = '{conversation_history}';

/**
 * Tool call args and responses can be large (e.g. search results). Cap how
 * much of each is rendered so compaction does not inflate the very context it
 * exists to shrink.
 */
const MAX_TOOL_CONTENT_CHARS = 2000;

const DEFAULT_PROMPT_TEMPLATE =
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
  ` essence of the interaction.\n\n${CONVERSATION_HISTORY_PLACEHOLDER}`;

/** Caps `text` at the tool content limit, marking the dropped characters. */
function truncate(text: string): string {
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
 * Thoughts emitted by a compacted event are skipped so a prior summary's
 * reasoning does not leak into the next summary.
 */
function formatEventsForPrompt(events: Event[]): string {
  const history: string[] = [];
  for (const event of events) {
    if (!event.content?.parts?.length) {
      continue;
    }
    const isCompaction = isCompactedEvent(event);
    for (const part of event.content.parts) {
      if (part.thought && part.text) {
        if (!isCompaction) {
          history.push(`${event.author} (thought): ${part.text}`);
        }
      } else if (part.text) {
        history.push(`${event.author}: ${part.text}`);
      }
      if (part.functionCall) {
        const args = truncate(JSON.stringify(part.functionCall.args ?? {}));
        history.push(
          `${event.author} called tool: ${part.functionCall.name}(${args})`,
        );
      }
      if (part.functionResponse) {
        const response = truncate(
          JSON.stringify(part.functionResponse.response ?? {}),
        );
        history.push(
          `Tool response from ${part.functionResponse.name}: ${response}`,
        );
      }
    }
  }
  return history.join('\n');
}

/**
 * Substitutes `history` into `template`.
 *
 * A template with no placeholder gets the history appended, so a plain prompt
 * written before the template syntax existed keeps working.
 */
function buildPrompt(template: string, history: string): string {
  if (!template.includes(CONVERSATION_HISTORY_PLACEHOLDER)) {
    return `${template}\n\n${history}`;
  }
  // The replacement is a function because the history is model- and
  // user-authored text: a string replacement would expand `$&` and friends.
  return template.replaceAll(CONVERSATION_HISTORY_PLACEHOLDER, () => history);
}

/** Options for constructing an {@link LlmSummarizer}. */
export interface LlmSummarizerOptions {
  /** The LLM instance used to generate the summary. */
  llm: BaseLlm;
  /**
   * Optional template for the summarization prompt. Defaults to a built-in
   * template when omitted.
   *
   * `{conversation_history}` marks where the formatted conversation is
   * substituted, and every occurrence is replaced. A template that contains no
   * placeholder gets the formatted conversation appended after a blank line.
   */
  prompt?: string;
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
    this.prompt = options.prompt || DEFAULT_PROMPT_TEMPLATE;
  }

  /**
   * Summarizes a list of events into a single {@link CompactedEvent} using the
   * configured LLM.
   *
   * @param events - The events to summarize.
   * @returns A promise resolving to the compacted representation, or `null`
   *     when the summarizer declines: `events` is empty, or the LLM produced no
   *     content. A caller that receives `null` must leave the session
   *     unchanged. An error raised by the LLM still propagates.
   */
  async summarize(events: Event[]): Promise<CompactedEvent | null> {
    if (events.length === 0) {
      return null;
    }

    const startTime = events[0].timestamp;
    const endTime = events[events.length - 1].timestamp;

    const request: LlmRequest = {
      model: this.llm.model,
      contents: [
        {
          role: 'user',
          parts: [
            {text: buildPrompt(this.prompt, formatEventsForPrompt(events))},
          ],
        },
      ],
      toolsDict: {},
      liveConnectConfig: {},
    };

    let compactedContent = '';
    let usageMetadata: GenerateContentResponseUsageMetadata | undefined;
    for await (const response of this.llm.generateContentAsync(
      request,
      false,
    )) {
      // A streaming aggregator reports usage on its final chunk, which often
      // carries no text, so read it before the text guard.
      usageMetadata = response.usageMetadata ?? usageMetadata;
      const text = response.content?.parts?.[0]?.text;
      if (!text) {
        continue;
      }
      compactedContent += text;
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
      startTime,
      endTime,
      compactedContent,
      usageMetadata,
    });
  }
}
