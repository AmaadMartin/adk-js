/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Ports `tests/unittests/apps/test_llm_event_summarizer.py` from
 * `google/adk-python` (`main`). The `it()` names are the Python test names,
 * verbatim, so the two suites can be compared by name.
 *
 * The Python suite parametrizes the class over `['GOOGLE_AI', 'VERTEX']`. That
 * is a pytest environment fixture with no bearing on this module, so it is not
 * ported.
 */

import {
  BaseLlm,
  BaseLlmConnection,
  Event,
  LlmRequest,
  LlmResponse,
  LlmSummarizer,
  createEvent,
} from '@google/adk';
import {describe, expect, it} from 'vitest';
import {createCompactedEvent} from '../../../src/events/compacted_event.js';

/**
 * The reference default template, from
 * `LlmEventSummarizer._DEFAULT_PROMPT_TEMPLATE`. Duplicated here on purpose:
 * it is what pins the prompt wording to adk-python.
 */
const EXPECTED_DEFAULT_PROMPT_TEMPLATE =
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

/** A prompt template that renders to the formatted history alone. */
const HISTORY_ONLY_TEMPLATE = '{conversation_history}';

class CapturingLlm extends BaseLlm {
  request: LlmRequest | undefined;
  stream: boolean | undefined;
  callCount = 0;

  constructor(private readonly responses: LlmResponse[]) {
    super({model: 'test-model'});
  }

  async *generateContentAsync(
    llmRequest: LlmRequest,
    stream?: boolean,
  ): AsyncGenerator<LlmResponse, void> {
    this.callCount++;
    this.request = llmRequest;
    this.stream = stream;
    for (const response of this.responses) {
      yield response;
    }
  }

  async connect(_llmRequest: LlmRequest): Promise<BaseLlmConnection> {
    throw new Error('Method not implemented.');
  }
}

function promptOf(llm: CapturingLlm): string {
  const text = llm.request?.contents?.[0]?.parts?.[0]?.text;
  if (text === undefined) {
    expect.fail('the summarizer sent no prompt to the LLM');
  }
  return text;
}

function textEvent(timestamp: number, text: string, author: string): Event {
  return createEvent({
    timestamp,
    author,
    content: {parts: [{text}]},
  });
}

/** Renders `events` through the public API, with the history as the prompt. */
async function formatEventsForPrompt(events: Event[]): Promise<string> {
  const llm = new CapturingLlm([
    {content: {role: 'model', parts: [{text: 'Summary'}]}},
  ]);
  const summarizer = new LlmSummarizer({llm, prompt: HISTORY_ONLY_TEMPLATE});
  await summarizer.summarize(events);
  return promptOf(llm);
}

describe('LlmEventSummarizer parity', () => {
  it('test_maybe_compact_events_success', async () => {
    const events = [
      textEvent(1000, 'Hello', 'user'),
      textEvent(2000, 'Hi there!', 'model'),
    ];
    const expectedPrompt = EXPECTED_DEFAULT_PROMPT_TEMPLATE.replace(
      HISTORY_ONLY_TEMPLATE,
      'user: Hello\nmodel: Hi there!',
    );
    const llm = new CapturingLlm([
      {content: {role: 'model', parts: [{text: 'Summary'}]}},
    ]);
    const summarizer = new LlmSummarizer({llm});

    const compactedEvent = await summarizer.summarize(events);
    if (!compactedEvent) {
      expect.fail('summarize() declined to summarize the events');
    }

    expect(compactedEvent.content?.parts?.[0]?.text).toBe('Summary');
    expect(compactedEvent.compactedContent).toBe('Summary');
    expect(compactedEvent.author).toBe('user');
    expect(compactedEvent.usageMetadata).toBeUndefined();
    expect(compactedEvent.startTime).toBe(1000);
    expect(compactedEvent.endTime).toBe(2000);

    expect(llm.callCount).toBe(1);
    expect(llm.request?.model).toBe('test-model');
    expect(llm.request?.contents?.[0]?.role).toBe('user');
    expect(promptOf(llm)).toBe(expectedPrompt);
    expect(llm.stream).toBe(false);
  });

  it('test_maybe_compact_events_empty_llm_response', async () => {
    const llm = new CapturingLlm([{content: undefined}]);
    const summarizer = new LlmSummarizer({llm});

    await expect(
      summarizer.summarize([textEvent(1000, 'Hello', 'user')]),
    ).resolves.toBeNull();
  });

  it('test_maybe_compact_events_includes_usage_metadata', async () => {
    const usageMetadata = {promptTokenCount: 10, candidatesTokenCount: 5};
    const llm = new CapturingLlm([
      {content: {role: 'model', parts: [{text: 'Summary'}]}, usageMetadata},
    ]);
    const summarizer = new LlmSummarizer({llm});

    const compactedEvent = await summarizer.summarize([
      textEvent(1000, 'Hello', 'user'),
      textEvent(2000, 'Hi there!', 'model'),
    ]);
    if (!compactedEvent) {
      expect.fail('summarize() declined to summarize the events');
    }

    expect(compactedEvent.usageMetadata).toEqual(usageMetadata);
  });

  it('test_maybe_compact_events_empty_input', async () => {
    const llm = new CapturingLlm([
      {content: {role: 'model', parts: [{text: 'Summary'}]}},
    ]);
    const summarizer = new LlmSummarizer({llm});

    await expect(summarizer.summarize([])).resolves.toBeNull();
    expect(llm.callCount).toBe(0);
  });

  it('test_format_events_for_prompt', async () => {
    const events = [
      textEvent(1000, 'User says...', 'user'),
      textEvent(2000, 'Model replies...', 'model'),
      textEvent(3000, 'Another user input', 'user'),
      textEvent(4000, 'More model text', 'model'),
      createEvent({timestamp: 5000, author: 'user'}),
      createEvent({
        timestamp: 6000,
        author: 'model',
        content: {parts: [{text: ''}]},
      }),
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

    // The tool payloads render as JSON, where Python renders `str(dict)`:
    // `{"q":"x"}` here against `{'q': 'x'}` there. The behaviour is ported,
    // not the serialization.
    expect(await formatEventsForPrompt(events)).toBe(
      'user: User says...\n' +
        'model: Model replies...\n' +
        'user: Another user input\n' +
        'model: More model text\n' +
        'model called tool: tool({"q":"x"})\n' +
        'Tool response from tool: {"result":"done"}',
    );
  });

  it('test_format_events_for_prompt_includes_thoughts', async () => {
    const events = [
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
    ];

    expect(await formatEventsForPrompt(events)).toBe(
      'user: What is the weather?\n' +
        'model (thought): Let me check the tool output.\n' +
        'model: It is sunny.',
    );
  });

  it('test_format_events_for_prompt_skips_compaction_event_thought', async () => {
    const events = [
      createCompactedEvent({
        timestamp: 1000,
        author: 'model',
        content: {
          parts: [
            {text: 'Stale summarizer reasoning.', thought: true},
            {text: 'Prior summary.'},
          ],
        },
        startTime: 0,
        endTime: 1000,
        compactedContent: 'Prior',
      }),
      textEvent(2000, 'New user input', 'user'),
    ];

    expect(await formatEventsForPrompt(events)).toBe(
      'model: Prior summary.\nuser: New user input',
    );
  });

  it('test_format_events_for_prompt_truncates_large_tool_response', async () => {
    const largeValue = 'x'.repeat(2500);
    const events = [
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
    ];

    const history = await formatEventsForPrompt(events);

    expect(history).toContain('Tool response from search:');
    expect(history).toContain('... [truncated');
    expect(history.length).toBeLessThan(largeValue.length);
  });
});
