/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {createEvent, createNewEventId, Event} from '../events/event.js';
import {BaseLlm} from '../models/base_llm.js';

import {BaseEventsSummarizer} from './base_events_summarizer.js';

/**
 * The summarization prompt used when no template is supplied. Ported verbatim
 * from `google/adk-python` `LlmEventSummarizer`.
 */
export const DEFAULT_SUMMARIZER_PROMPT_TEMPLATE =
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
  ' essence of the interaction.\n\n{conversation_history}';

/**
 * Tool call args and responses can be large (search results, for instance), so
 * cap how much of each is rendered. Otherwise compaction inflates the very
 * context it exists to shrink.
 */
const MAX_TOOL_CONTENT_CHARS = 2000;

/** The placeholder the prompt template uses for the rendered history. */
const CONVERSATION_HISTORY_PLACEHOLDER = '{conversation_history}';

/**
 * Caps `text` at `limit` characters, marking how many were dropped.
 */
export function truncate(text: string, limit = MAX_TOOL_CONTENT_CHARS): string {
  if (text.length <= limit) {
    return text;
  }
  return `${text.slice(0, limit)}... [truncated ${text.length - limit} chars]`;
}

/**
 * Renders a tool call's args or a tool response's payload for the prompt.
 *
 * Both are optional in the `@google/genai` types, and `JSON.stringify` returns
 * `undefined` rather than a string when handed one, so an absent payload
 * renders as empty rather than crashing the summarizer.
 */
function renderToolPayload(payload: unknown): string {
  return truncate(JSON.stringify(payload) ?? '');
}

/**
 * Renders events as prompt text, including thoughts and tool traffic.
 *
 * Thoughts carry the agent's analysis of tool responses, and tool calls and
 * responses carry the evidence gathered so far, so all three are included.
 * Thoughts emitted by a compaction event are skipped so a prior summary's
 * reasoning does not leak into the next summary.
 *
 * Mirrors `google/adk-python` `_format_events_for_prompt`.
 */
export function formatEventsForPrompt(events: Event[]): string {
  const lines: string[] = [];
  for (const event of events) {
    if (!event.content?.parts) {
      continue;
    }
    const isCompaction = Boolean(event.actions?.compaction);
    for (const part of event.content.parts) {
      if (part.thought && part.text) {
        if (!isCompaction) {
          lines.push(`${event.author} (thought): ${part.text}`);
        }
      } else if (part.text) {
        lines.push(`${event.author}: ${part.text}`);
      }
      if (part.functionCall) {
        const args = renderToolPayload(part.functionCall.args);
        lines.push(
          `${event.author} called tool: ${part.functionCall.name}(${args})`,
        );
      }
      if (part.functionResponse) {
        const response = renderToolPayload(part.functionResponse.response);
        lines.push(
          `Tool response from ${part.functionResponse.name}: ${response}`,
        );
      }
    }
  }
  return lines.join('\n');
}

/** Options for {@link LlmEventSummarizer}. */
export interface LlmEventSummarizerOptions {
  /** The model used to write the summary. */
  llm: BaseLlm;

  /**
   * Prompt template containing a `{conversation_history}` placeholder.
   * Defaults to a built-in summarization prompt.
   */
  promptTemplate?: string;
}

/**
 * Summarizes a window of session events with an LLM.
 *
 * Mirrors `google/adk-python` `LlmEventSummarizer`.
 */
export class LlmEventSummarizer implements BaseEventsSummarizer {
  private readonly llm: BaseLlm;
  private readonly promptTemplate: string;

  constructor(options: LlmEventSummarizerOptions) {
    this.llm = options.llm;
    this.promptTemplate =
      options.promptTemplate ?? DEFAULT_SUMMARIZER_PROMPT_TEMPLATE;
  }

  async maybeSummarizeEvents(events: Event[]): Promise<Event | undefined> {
    if (events.length === 0) {
      return undefined;
    }

    const history = formatEventsForPrompt(events);
    // A function replacement keeps `$&`, `` $` `` and `$'` in the conversation
    // from being expanded as replacement patterns.
    const prompt = this.promptTemplate.replace(
      CONVERSATION_HISTORY_PLACEHOLDER,
      () => history,
    );

    for await (const response of this.llm.generateContentAsync(
      {
        model: this.llm.model,
        contents: [{role: 'user', parts: [{text: prompt}]}],
        toolsDict: {},
        liveConnectConfig: {},
      },
      false,
    )) {
      if (!response.content) {
        continue;
      }
      const compactedContent = {...response.content, role: 'model'};
      return createEvent({
        // Author 'user' matches adk-python: the summary re-enters the next
        // prompt as context the agent is given, not as a turn it produced.
        author: 'user',
        invocationId: createNewEventId(),
        usageMetadata: response.usageMetadata,
        actions: {
          compaction: {
            startTimestamp: events[0].timestamp,
            endTimestamp: events[events.length - 1].timestamp,
            compactedContent,
          },
        },
      });
    }

    return undefined;
  }
}
