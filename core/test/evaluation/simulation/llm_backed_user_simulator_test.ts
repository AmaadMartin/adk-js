/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  BaseLlm,
  ConversationScenario,
  createEvent,
  Event,
  LlmBackedUserSimulator,
  LlmBackedUserSimulatorConfig,
  LLMRegistry,
  LlmResponse,
  Status,
  UserPersona,
} from '@google/adk';
import {afterEach, describe, expect, it, vi} from 'vitest';

// summarizeConversation ports an adk-python private and is intentionally
// internal, so it is imported via a relative path.
import {summarizeConversation} from '../../../src/evaluation/simulation/llm_backed_user_simulator.js';

const INPUT_EVENTS: Event[] = [
  createEvent({
    author: 'user',
    content: {parts: [{text: 'Can you help me?'}], role: 'user'},
    invocationId: 'inv1',
  }),
  createEvent({
    author: 'helpful_assistant',
    content: {
      parts: [
        {text: "I'll get the user's name and greet them first.", thought: true},
        {functionCall: {name: 'get_user_name'}},
        {
          functionResponse: {
            name: 'get_user_name',
            response: {name: 'John Doe'},
          },
        },
        {text: 'Hi John, what can I do for you?'},
      ],
      role: 'model',
    },
    invocationId: 'inv1',
  }),
];

const INPUT_EVENTS_LONG: Event[] = [
  ...INPUT_EVENTS,
  createEvent({
    author: 'user',
    content: {parts: [{text: 'I need to book a flight.'}], role: 'user'},
    invocationId: 'inv2',
  }),
  createEvent({
    author: 'helpful_assistant',
    content: {
      parts: [{text: 'Sure, what is your departure date and destination?'}],
      role: 'model',
    },
    invocationId: 'inv2',
  }),
];

const EXPECTED_REWRITTEN_DIALOGUE =
  'user: Can you help me?\n\n' +
  'helpful_assistant: Hi John, what can I do for you?';

const EXPECTED_REWRITTEN_DIALOGUE_LONG =
  EXPECTED_REWRITTEN_DIALOGUE +
  '\n\nuser: I need to book a flight.\n\n' +
  'helpful_assistant: Sure, what is your departure date and destination?';

function fakeLlm(responses: LlmResponse[]): {
  llm: BaseLlm;
  generate: ReturnType<typeof vi.fn>;
} {
  const generate = vi.fn(async function* (): AsyncGenerator<LlmResponse> {
    for (const response of responses) {
      yield response;
    }
  });
  return {
    llm: {generateContentAsync: generate} as unknown as BaseLlm,
    generate,
  };
}

function makeScenario(userPersona?: UserPersona): ConversationScenario {
  return new ConversationScenario({
    startingPrompt: 'Hello',
    conversationPlan: 'test plan',
    userPersona,
  });
}

function setup(
  responses: LlmResponse[],
  options: {
    scenario?: ConversationScenario;
    config?: LlmBackedUserSimulatorConfig;
  } = {},
) {
  const {llm, generate} = fakeLlm(responses);
  vi.spyOn(LLMRegistry, 'newLlm').mockReturnValue(llm);
  const simulator = new LlmBackedUserSimulator({
    config:
      options.config ?? new LlmBackedUserSimulatorConfig({model: 'test-model'}),
    conversationScenario: options.scenario ?? makeScenario(),
  });
  return {simulator, generate};
}

// Advances past the fixed starting prompt (turn 0) so the next call uses the
// LLM (turn 1+), the state the reference tests exercise.
async function advancePastStartingPrompt(
  simulator: LlmBackedUserSimulator,
): Promise<void> {
  const first = await simulator.getNextUserMessage([]);
  expect(first.status).toBe(Status.SUCCESS);
}

describe('LlmBackedUserSimulatorConfig', () => {
  it('accepts null and valid custom instructions and rejects invalid ones', () => {
    expect(
      new LlmBackedUserSimulatorConfig({customInstructions: undefined})
        .customInstructions,
    ).toBeUndefined();

    const valid =
      '{{ stop_signal }} {{ conversation_plan }} {{ conversation_history }}';
    expect(
      new LlmBackedUserSimulatorConfig({customInstructions: valid})
        .customInstructions,
    ).toBe(valid);

    expect(
      () =>
        new LlmBackedUserSimulatorConfig({
          customInstructions:
            'Instructions with missing formatting placeholders',
        }),
    ).toThrow();
  });

  it('applies defaults and honors explicitly provided fields', () => {
    const defaults = new LlmBackedUserSimulatorConfig();
    expect(defaults.type).toBe('llm_backed');
    expect(defaults.model).toBe('gemini-2.5-flash');
    expect(defaults.maxAllowedInvocations).toBe(20);
    expect(defaults.includeFunctionCalls).toBe(false);
    expect(defaults.modelConfiguration).toEqual({
      thinkingConfig: {includeThoughts: true, thinkingBudget: 10240},
    });

    const custom = new LlmBackedUserSimulatorConfig({
      model: 'custom-model',
      modelConfiguration: {temperature: 0.5},
      maxAllowedInvocations: 5,
      includeFunctionCalls: true,
    });
    expect(custom.model).toBe('custom-model');
    expect(custom.modelConfiguration).toEqual({temperature: 0.5});
    expect(custom.maxAllowedInvocations).toBe(5);
    expect(custom.includeFunctionCalls).toBe(true);
  });

  it('rejects a non-llm_backed type', () => {
    expect(
      () =>
        new LlmBackedUserSimulatorConfig({
          type: 'something_else' as 'llm_backed',
        }),
    ).toThrow("`type` must be 'llm_backed'.");
  });
});

describe('summarizeConversation', () => {
  it('summarizes text-only dialogue', () => {
    expect(summarizeConversation(INPUT_EVENTS)).toBe(
      EXPECTED_REWRITTEN_DIALOGUE,
    );
    expect(summarizeConversation(INPUT_EVENTS_LONG)).toBe(
      EXPECTED_REWRITTEN_DIALOGUE_LONG,
    );
  });

  it('includes function calls and responses when requested', () => {
    const expected =
      'user: Can you help me?\n\n' +
      "helpful_assistant called tool 'get_user_name' with args: None\n\n" +
      "Tool 'get_user_name' returned: {'name': 'John Doe'}\n\n" +
      'helpful_assistant: Hi John, what can I do for you?';
    expect(summarizeConversation(INPUT_EVENTS, true)).toBe(expected);
  });

  it('renders nested tool values Python-repr style and skips empty events', () => {
    const event = createEvent({
      author: 'agent',
      content: {
        parts: [
          {
            functionResponse: {
              name: 'tool',
              response: {count: 3, tags: ['a'], note: null},
            },
          },
        ],
        role: 'model',
      },
      invocationId: 'x',
    });
    expect(summarizeConversation([event], true)).toBe(
      "Tool 'tool' returned: {'count': 3, 'tags': ['a'], 'note': None}",
    );

    const noContent = createEvent({author: 'x', invocationId: 'y'});
    expect(summarizeConversation([noContent], true)).toBe('');
  });
});

describe('LlmBackedUserSimulator', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns the starting prompt on the first invocation without calling the model', async () => {
    const {simulator, generate} = setup([]);
    const result = await simulator.getNextUserMessage([]);
    expect(result.status).toBe(Status.SUCCESS);
    expect(result.userMessage).toEqual({
      parts: [{text: 'Hello'}],
      role: 'user',
    });
    expect(generate).not.toHaveBeenCalled();
  });

  it('returns TURN_LIMIT_REACHED once the invocation limit is hit', async () => {
    const {simulator} = setup([], {
      config: new LlmBackedUserSimulatorConfig({maxAllowedInvocations: 1}),
    });
    await advancePastStartingPrompt(simulator);
    const result = await simulator.getNextUserMessage(INPUT_EVENTS);
    expect(result.status).toBe(Status.TURN_LIMIT_REACHED);
    expect(result.userMessage).toBeUndefined();
  });

  it('detects the stop signal', async () => {
    const {simulator} = setup([
      {content: {parts: [{text: 'Thanks! Bye!</finished>'}]}},
    ]);
    await advancePastStartingPrompt(simulator);
    const result = await simulator.getNextUserMessage(INPUT_EVENTS);
    expect(result.status).toBe(Status.STOP_SIGNAL_DETECTED);
    expect(result.userMessage).toBeUndefined();
  });

  it('throws when the stream is empty', async () => {
    const {simulator} = setup([]);
    await advancePastStartingPrompt(simulator);
    await expect(simulator.getNextUserMessage(INPUT_EVENTS)).rejects.toThrow(
      'Failed to generate a user message: LLM returned empty response',
    );
  });

  it('throws when the response is safety blocked', async () => {
    const {simulator} = setup([
      {
        content: undefined,
        errorCode: 'SAFETY',
        errorMessage: 'Blocked by safety',
      },
    ]);
    await advancePastStartingPrompt(simulator);
    await expect(simulator.getNextUserMessage(INPUT_EVENTS)).rejects.toThrow(
      'Failed to generate a user message: safety filters or other error' +
        ' (code=SAFETY)',
    );
  });

  it('throws when safety blocked without an error message', async () => {
    const {simulator} = setup([{content: undefined, errorCode: 'SAFETY'}]);
    await advancePastStartingPrompt(simulator);
    await expect(simulator.getNextUserMessage(INPUT_EVENTS)).rejects.toThrow(
      'Failed to generate a user message: safety filters or other error' +
        ' (code=SAFETY)',
    );
  });

  it('throws when only thinking tokens are returned', async () => {
    const {simulator} = setup([
      {content: {parts: [{text: 'thinking...', thought: true}]}},
    ]);
    await advancePastStartingPrompt(simulator);
    await expect(simulator.getNextUserMessage(INPUT_EVENTS)).rejects.toThrow(
      'Failed to generate a user message: LLM returned only thinking tokens',
    );
  });

  it('returns a successful user message', async () => {
    const {simulator} = setup([
      {content: {parts: [{text: 'I need to book a flight.'}]}},
    ]);
    await advancePastStartingPrompt(simulator);
    const result = await simulator.getNextUserMessage(INPUT_EVENTS);
    expect(result.status).toBe(Status.SUCCESS);
    expect(result.userMessage).toEqual({
      parts: [{text: 'I need to book a flight.'}],
      role: 'user',
    });
  });

  it('returns a successful user message with a persona', async () => {
    const persona: UserPersona = {
      id: 'test_persona',
      description: 'A test persona',
      behaviors: [
        {
          name: 'polite',
          description: 'is polite',
          behaviorInstructions: ['Always say please and thank you.'],
          violationRubrics: ['is rude'],
        },
      ],
    };
    const {simulator} = setup(
      [{content: {parts: [{text: 'I need to book a flight.'}]}}],
      {scenario: makeScenario(persona)},
    );
    await advancePastStartingPrompt(simulator);
    const result = await simulator.getNextUserMessage(INPUT_EVENTS);
    expect(result.status).toBe(Status.SUCCESS);
    expect(result.userMessage).toEqual({
      parts: [{text: 'I need to book a flight.'}],
      role: 'user',
    });
  });

  it('accumulates text and ignores thoughts when assembling the response', async () => {
    const {simulator} = setup([
      {
        content: {
          parts: [
            {text: 'some thought', thought: true},
            {text: 'Hello world!'},
          ],
        },
      },
    ]);
    await advancePastStartingPrompt(simulator);
    const result = await simulator.getNextUserMessage(INPUT_EVENTS);
    expect(result.status).toBe(Status.SUCCESS);
    expect(result.userMessage).toEqual({
      parts: [{text: 'Hello world!'}],
      role: 'user',
    });
  });

  it('skips response chunks without content and accumulates the rest', async () => {
    const {simulator} = setup([
      {content: undefined},
      {content: {parts: [{text: 'ok'}]}},
    ]);
    await advancePastStartingPrompt(simulator);
    const result = await simulator.getNextUserMessage(INPUT_EVENTS);
    expect(result.status).toBe(Status.SUCCESS);
    expect(result.userMessage).toEqual({parts: [{text: 'ok'}], role: 'user'});
  });

  it('throws for the not-yet-implemented simulation evaluator', () => {
    const {simulator} = setup([]);
    expect(() => simulator.getSimulationEvaluator()).toThrow(
      'Not implemented.',
    );
  });
});
