/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Ported from google/adk-python,
 * `tests/unittests/apps/test_llm_event_summarizer.py` (ref `main`).
 * The `it()` names are the Python test names, kept verbatim.
 */

import {
  BaseLlm,
  BaseLlmConnection,
  CompactedEvent,
  Event,
  LlmRequest,
  LlmResponse,
  LlmSummarizer,
  createEvent,
} from '@google/adk';
import {describe, expect, it} from 'vitest';

/** The default prompt template, up to the `{conversation_history}` slot. */
const PROMPT_PREFIX =
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
  ' essence of the interaction.\n\n';

class RecordingLlm extends BaseLlm {
  readonly requests: LlmRequest[] = [];
  readonly streams: Array<boolean | undefined> = [];

  constructor(private readonly responses: LlmResponse[] = []) {
    super({model: 'mock-model'});
  }

  async *generateContentAsync(
    llmRequest: LlmRequest,
    stream?: boolean,
  ): AsyncGenerator<LlmResponse, void> {
    this.requests.push(llmRequest);
    this.streams.push(stream);
    for (const response of this.responses) {
      yield response;
    }
  }

  async connect(_llmRequest: LlmRequest): Promise<BaseLlmConnection> {
    throw new Error('Method not implemented.');
  }
}

function summaryLlm(): RecordingLlm {
  return new RecordingLlm([
    {content: {role: 'model', parts: [{text: 'Summary'}]}},
  ]);
}

function textEvent(timestamp: number, text: string, author: string): Event {
  return createEvent({
    timestamp,
    author,
    content: {parts: [{text}]},
  });
}

/** Reads the conversation history back out of the captured prompt. */
function historyOf(llm: RecordingLlm): string {
  const prompt = llm.requests[0].contents[0].parts?.[0]?.text;
  expect(prompt?.startsWith(PROMPT_PREFIX)).toBe(true);
  return prompt!.slice(PROMPT_PREFIX.length);
}

describe('LlmSummarizer parity with adk-python LlmEventSummarizer', () => {
  it('test_maybe_compact_events_success', async () => {
    const llm = summaryLlm();
    const summarizer = new LlmSummarizer({llm});
    const events = [
      textEvent(1000, 'Hello', 'user'),
      textEvent(2000, 'Hi there!', 'model'),
    ];

    const compactedEvent = await summarizer.summarize(events);

    expect(compactedEvent).not.toBeNull();
    expect(compactedEvent!.content?.parts?.[0]?.text).toBe('Summary');
    expect(compactedEvent!.compactedContent).toBe('Summary');
    expect(compactedEvent!.author).toBe('user');
    expect(compactedEvent!.usageMetadata).toBeUndefined();
    expect(compactedEvent!.startTime).toBe(1000);
    expect(compactedEvent!.endTime).toBe(2000);

    expect(llm.requests.length).toBe(1);
    expect(llm.requests[0].model).toBe('mock-model');
    expect(llm.requests[0].contents[0].role).toBe('user');
    expect(llm.requests[0].contents[0].parts?.[0]?.text).toBe(
      `${PROMPT_PREFIX}user: Hello\nmodel: Hi there!`,
    );
    expect(llm.streams[0]).toBe(false);
  });

  it('test_maybe_compact_events_empty_llm_response', async () => {
    const llm = new RecordingLlm([{content: undefined}]);
    const summarizer = new LlmSummarizer({llm});

    await expect(
      summarizer.summarize([textEvent(1000, 'Hello', 'user')]),
    ).resolves.toBeNull();
  });

  it('test_maybe_compact_events_includes_usage_metadata', async () => {
    const llm = new RecordingLlm([
      {
        content: {role: 'model', parts: [{text: 'Summary'}]},
        usageMetadata: {promptTokenCount: 10, candidatesTokenCount: 5},
      },
    ]);
    const summarizer = new LlmSummarizer({llm});

    const compactedEvent = await summarizer.summarize([
      textEvent(1000, 'Hello', 'user'),
      textEvent(2000, 'Hi there!', 'model'),
    ]);

    expect(compactedEvent).not.toBeNull();
    expect(compactedEvent!.usageMetadata).toEqual({
      promptTokenCount: 10,
      candidatesTokenCount: 5,
    });
  });

  it('test_maybe_compact_events_empty_input', async () => {
    const llm = summaryLlm();
    const summarizer = new LlmSummarizer({llm});

    await expect(summarizer.summarize([])).resolves.toBeNull();
    expect(llm.requests.length).toBe(0);
  });

  it('test_format_events_for_prompt', async () => {
    const llm = summaryLlm();
    const summarizer = new LlmSummarizer({llm});
    const events = [
      textEvent(1000, 'User says...', 'user'),
      textEvent(2000, 'Model replies...', 'model'),
      textEvent(3000, 'Another user input', 'user'),
      textEvent(4000, 'More model text', 'model'),
      createEvent({timestamp: 5000, author: 'user'}),
      textEvent(6000, '', 'model'),
      createEvent({
        timestamp: 7000,
        author: 'model',
        content: {
          parts: [{functionCall: {id: 'call_1', name: 'tool', args: {q: 'x'}}}],
        },
      }),
      createEvent({
        timestamp: 8000,
        author: 'model',
        content: {
          parts: [
            {
              functionResponse: {
                id: 'call_1',
                name: 'tool',
                response: {result: 'done'},
              },
            },
          ],
        },
      }),
    ];

    await summarizer.summarize(events);

    expect(historyOf(llm)).toBe(
      'user: User says...\n' +
        'model: Model replies...\n' +
        'user: Another user input\n' +
        'model: More model text\n' +
        'model called tool: tool({"q":"x"})\n' +
        'Tool response from tool: {"result":"done"}',
    );
  });

  it('test_format_events_for_prompt_includes_thoughts', async () => {
    const llm = summaryLlm();
    const summarizer = new LlmSummarizer({llm});

    await summarizer.summarize([
      textEvent(1000, 'What is the weather?', 'user'),
      createEvent({
        timestamp: 2000,
        author: 'model',
        content: {
          parts: [
            {text: 'Let me check the tool output.', thought: true},
            {text: 'It is sunny.'},
          ],
        },
      }),
    ]);

    expect(historyOf(llm)).toBe(
      'user: What is the weather?\n' +
        'model (thought): Let me check the tool output.\n' +
        'model: It is sunny.',
    );
  });

  it('test_format_events_for_prompt_skips_compaction_event_thought', async () => {
    const llm = summaryLlm();
    const summarizer = new LlmSummarizer({llm});
    const compactionEvent: CompactedEvent = {
      ...createEvent({
        timestamp: 1000,
        author: 'model',
        content: {
          parts: [
            {text: 'Stale summarizer reasoning.', thought: true},
            {text: 'Prior summary.'},
          ],
        },
      }),
      isCompacted: true,
      startTime: 0,
      endTime: 1000,
      compactedContent: 'Prior',
    };

    await summarizer.summarize([
      compactionEvent,
      textEvent(2000, 'New user input', 'user'),
    ]);

    expect(historyOf(llm)).toBe('model: Prior summary.\nuser: New user input');
  });

  it('test_format_events_for_prompt_truncates_large_tool_response', async () => {
    const llm = summaryLlm();
    const summarizer = new LlmSummarizer({llm});
    const largeValue = 'x'.repeat(2500);

    await summarizer.summarize([
      createEvent({
        timestamp: 1000,
        author: 'model',
        content: {
          parts: [
            {
              functionResponse: {
                id: 'call_1',
                name: 'search',
                response: {data: largeValue},
              },
            },
          ],
        },
      }),
    ]);

    const history = historyOf(llm);
    expect(history).toContain('Tool response from search:');
    expect(history).toContain('... [truncated');
    expect(history.length).toBeLessThan(largeValue.length);
  });
});
