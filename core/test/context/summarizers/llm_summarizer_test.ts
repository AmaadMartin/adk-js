/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
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

class MockLlm extends BaseLlm {
  lastRequest: LlmRequest | undefined;
  lastStream: boolean | undefined;
  callCount = 0;

  constructor(
    private responses: LlmResponse[],
    model = 'mock-model',
  ) {
    super({model});
  }

  async *generateContentAsync(
    llmRequest: LlmRequest,
    stream?: boolean,
  ): AsyncGenerator<LlmResponse, void> {
    this.callCount++;
    this.lastRequest = llmRequest;
    this.lastStream = stream;
    for (const response of this.responses) {
      if (response.errorCode) {
        throw new Error(response.errorMessage || 'LLM Error');
      }
      yield response;
    }
  }

  async connect(_llmRequest: LlmRequest): Promise<BaseLlmConnection> {
    throw new Error('Method not implemented.');
  }
}

function promptOf(mockLlm: MockLlm): string {
  const text = mockLlm.lastRequest?.contents?.[0]?.parts?.[0]?.text;
  if (text === undefined) {
    expect.fail('the summarizer sent no prompt to the LLM');
  }
  return text;
}

function textEvent(timestamp: number, text: string, author: string): Event {
  return createEvent({timestamp, author, content: {parts: [{text}]}});
}

/** Runs the summarizer over `events` and returns the prompt the LLM saw. */
async function capturePrompt(
  events: Event[],
  prompt?: string,
): Promise<string> {
  const mockLlm = new MockLlm([
    {content: {role: 'model', parts: [{text: 'summary'}]}},
  ]);
  const summarizer = new LlmSummarizer({llm: mockLlm, prompt});
  await summarizer.summarize(events);
  return promptOf(mockLlm);
}

describe('LlmSummarizer', () => {
  it('should summarize events using the LLM and return a CompactedEvent', async () => {
    const mockLlm = new MockLlm([
      {
        content: {
          role: 'model',
          parts: [{text: 'This is the summarized '}],
        },
      },
      {
        content: {
          role: 'model',
          parts: [{text: 'content from the LLM.'}],
        },
      },
    ]);

    const summarizer = new LlmSummarizer({llm: mockLlm as unknown as BaseLlm});

    const events: Event[] = [
      createEvent({
        author: 'user',
        timestamp: 1000,
        content: {role: 'user', parts: [{text: 'Hello'}]},
      }),
      createEvent({
        author: 'agent',
        timestamp: 2000,
        content: {role: 'model', parts: [{text: 'Hi there'}]},
      }),
    ];

    const compactedEvent = await summarizer.summarize(events);
    if (!compactedEvent) {
      expect.fail('summarize() declined to summarize the events');
    }

    expect(compactedEvent.isCompacted).toBe(true);
    expect(compactedEvent.startTime).toBe(1000);
    expect(compactedEvent.endTime).toBe(2000);
    expect(compactedEvent.author).toBe('user');
    expect(compactedEvent.content?.role).toBe('model');
    expect(compactedEvent.compactedContent).toBe(
      'This is the summarized content from the LLM.',
    );
    expect(compactedEvent.content?.parts?.[0]?.text).toBe(
      'This is the summarized content from the LLM.',
    );
    expect(compactedEvent.id).toBeDefined();
  });

  it('should return null if the LLM fails to return valid summary', async () => {
    const mockLlm = new MockLlm([
      {
        // empty content
        content: {
          role: 'model',
          parts: [],
        },
      },
    ]);

    const summarizer = new LlmSummarizer({llm: mockLlm as unknown as BaseLlm});

    const events: Event[] = [
      createEvent({
        author: 'user',
        timestamp: 1000,
        content: {role: 'user', parts: [{text: 'Hello'}]},
      }),
    ];

    await expect(summarizer.summarize(events)).resolves.toBeNull();
  });

  it('should return null when called with empty events list', async () => {
    const mockLlm = new MockLlm([]);
    const summarizer = new LlmSummarizer({llm: mockLlm as unknown as BaseLlm});

    await expect(summarizer.summarize([])).resolves.toBeNull();
  });

  it('should substitute the history at every placeholder in the prompt', async () => {
    const events: Event[] = [
      createEvent({
        author: 'user',
        timestamp: 1000,
        content: {role: 'user', parts: [{text: 'Hello'}]},
      }),
    ];

    const prompt = await capturePrompt(
      events,
      'BEFORE {conversation_history} AFTER {conversation_history} END',
    );

    expect(prompt).toBe('BEFORE user: Hello AFTER user: Hello END');
  });

  it('should append the history when the prompt has no placeholder', async () => {
    const events: Event[] = [
      createEvent({
        author: 'user',
        timestamp: 1000,
        content: {role: 'user', parts: [{text: 'Hello'}]},
      }),
    ];

    const prompt = await capturePrompt(events, 'Summarize this.');

    expect(prompt).toBe('Summarize this.\n\nuser: Hello');
  });

  it('should not expand dollar patterns in the substituted history', async () => {
    const events: Event[] = [
      createEvent({
        author: 'user',
        timestamp: 1000,
        content: {role: 'user', parts: [{text: "cost $& and $` and $'"}]},
      }),
    ];

    const prompt = await capturePrompt(events, '[{conversation_history}]');

    expect(prompt).toBe("[user: cost $& and $` and $']");
  });

  it('should render tool parts that carry no args or response', async () => {
    const events: Event[] = [
      createEvent({
        author: 'model',
        timestamp: 1000,
        content: {
          role: 'model',
          parts: [
            {functionCall: {name: 'tool'}},
            {functionResponse: {name: 'tool'}},
          ],
        },
      }),
    ];

    const prompt = await capturePrompt(events, '{conversation_history}');

    expect(prompt).toBe(
      'model called tool: tool({})\nTool response from tool: {}',
    );
  });

  it('should render nothing for a thought part that carries no text', async () => {
    const events: Event[] = [
      createEvent({
        author: 'model',
        timestamp: 1000,
        content: {
          role: 'model',
          parts: [{thought: true}, {text: 'Visible.'}],
        },
      }),
    ];

    const prompt = await capturePrompt(events, '{conversation_history}');

    expect(prompt).toBe('model: Visible.');
  });

  it('should keep the usage metadata of a final chunk that carries no text', async () => {
    const usageMetadata = {promptTokenCount: 42, candidatesTokenCount: 7};
    const mockLlm = new MockLlm([
      {content: {role: 'model', parts: [{text: 'Summary'}]}},
      {content: undefined, usageMetadata},
    ]);
    const summarizer = new LlmSummarizer({llm: mockLlm});

    const compactedEvent = await summarizer.summarize([
      textEvent(1000, 'Hello', 'user'),
    ]);
    if (!compactedEvent) {
      expect.fail('summarize() declined to summarize the events');
    }

    expect(compactedEvent.usageMetadata).toEqual(usageMetadata);
  });

  /**
   * Ports `tests/unittests/apps/test_llm_event_summarizer.py` from
   * `google/adk-python` (`main`). The `it()` names are the Python test names,
   * verbatim, so the two suites can be compared by name.
   *
   * The Python suite parametrizes the class over `['GOOGLE_AI', 'VERTEX']`.
   * That is a pytest environment fixture with no bearing on this module, so it
   * is not ported.
   */
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
      const mockLlm = new MockLlm(
        [{content: {role: 'model', parts: [{text: 'Summary'}]}}],
        'test-model',
      );
      const summarizer = new LlmSummarizer({llm: mockLlm});

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

      expect(mockLlm.callCount).toBe(1);
      expect(mockLlm.lastRequest?.model).toBe('test-model');
      expect(mockLlm.lastRequest?.contents?.[0]?.role).toBe('user');
      expect(promptOf(mockLlm)).toBe(expectedPrompt);
      expect(mockLlm.lastStream).toBe(false);
    });

    it('test_maybe_compact_events_empty_llm_response', async () => {
      const mockLlm = new MockLlm([{content: undefined}]);
      const summarizer = new LlmSummarizer({llm: mockLlm});

      await expect(
        summarizer.summarize([textEvent(1000, 'Hello', 'user')]),
      ).resolves.toBeNull();
    });

    it('test_maybe_compact_events_includes_usage_metadata', async () => {
      const usageMetadata = {promptTokenCount: 10, candidatesTokenCount: 5};
      const mockLlm = new MockLlm([
        {content: {role: 'model', parts: [{text: 'Summary'}]}, usageMetadata},
      ]);
      const summarizer = new LlmSummarizer({llm: mockLlm});

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
      const mockLlm = new MockLlm([
        {content: {role: 'model', parts: [{text: 'Summary'}]}},
      ]);
      const summarizer = new LlmSummarizer({llm: mockLlm});

      await expect(summarizer.summarize([])).resolves.toBeNull();
      expect(mockLlm.callCount).toBe(0);
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
            parts: [
              {functionCall: {id: 'call_1', name: 'tool', args: {q: 'x'}}},
            ],
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
      expect(await capturePrompt(events, HISTORY_ONLY_TEMPLATE)).toBe(
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

      expect(await capturePrompt(events, HISTORY_ONLY_TEMPLATE)).toBe(
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

      expect(await capturePrompt(events, HISTORY_ONLY_TEMPLATE)).toBe(
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

      const history = await capturePrompt(events, HISTORY_ONLY_TEMPLATE);

      expect(history).toContain('Tool response from search:');
      expect(history).toContain('... [truncated');
      expect(history.length).toBeLessThan(largeValue.length);
    });
  });
});
