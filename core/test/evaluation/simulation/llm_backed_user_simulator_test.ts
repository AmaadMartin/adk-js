/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Ports `tests/unittests/evaluation/simulation/test_llm_backed_user_simulator.py`
 * from google/adk-python at commit baf7efbaa92c. Each `it` keeps the name of
 * the Python test it ports.
 */

import {
  createEvent,
  InputValidationError,
  LlmBackedUserSimulator,
  summarizeConversation,
  UserSimulatorStatus,
  type ConversationScenario,
  type Event,
  type UserPersona,
} from '@google/adk';
import {describe, expect, it} from 'vitest';

import {FAKE_MODEL, FakeLlm} from './fake_llm.js';

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

const EXPECTED_REWRITTEN_DIALOGUE = `user: Can you help me?

helpful_assistant: Hi John, what can I do for you?`;

const EXPECTED_REWRITTEN_DIALOGUE_LONG = `${EXPECTED_REWRITTEN_DIALOGUE}

user: I need to book a flight.

helpful_assistant: Sure, what is your departure date and destination?`;

const CONVERSATION_SCENARIO: ConversationScenario = {
  startingPrompt: 'Hello',
  conversationPlan: 'test plan',
};

const USER_PERSONA: UserPersona = {
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

const CONVERSATION_SCENARIO_WITH_PERSONA: ConversationScenario = {
  startingPrompt: 'Hello',
  conversationPlan: 'test plan with persona',
  userPersona: USER_PERSONA,
};

/**
 * Builds a simulator and plays its opening turn, so the call the test makes
 * next asks the model. adk-python's fixture sets the private invocation count
 * instead; playing the turn reaches the same state through the public API.
 */
async function simulatorPastOpeningTurn(
  conversationScenario: ConversationScenario = CONVERSATION_SCENARIO,
): Promise<{simulator: LlmBackedUserSimulator; llm: FakeLlm}> {
  const llm = new FakeLlm();
  const simulator = new LlmBackedUserSimulator({
    config: {model: FAKE_MODEL},
    conversationScenario,
    llm,
  });
  await simulator.getNextUserMessage([]);
  return {simulator, llm};
}

it('test_llm_backed_user_simulator_config_validation', () => {
  const build = (customInstructions?: string) =>
    new LlmBackedUserSimulator({
      config: {customInstructions},
      conversationScenario: CONVERSATION_SCENARIO,
      llm: new FakeLlm(),
    });

  expect(() => build(undefined)).not.toThrow();
  expect(() =>
    build(
      '{{ stop_signal }} {{ conversation_plan }} {{ conversation_history }}',
    ),
  ).not.toThrow();
  expect(() =>
    build('Instructions with missing formatting placeholders'),
  ).toThrowError(InputValidationError);
});

describe('TestHelperMethods', () => {
  it('test_convert_conversation_to_user_sim_pov', () => {
    expect(summarizeConversation(INPUT_EVENTS)).toBe(
      EXPECTED_REWRITTEN_DIALOGUE,
    );
    expect(summarizeConversation(INPUT_EVENTS_LONG)).toBe(
      EXPECTED_REWRITTEN_DIALOGUE_LONG,
    );
  });

  it('test_summarize_conversation_with_function_calls', () => {
    // Divergence: adk-python renders the tool argument and the tool response
    // with Python's `repr` (`None`, `{'name': 'John Doe'}`). adk-js renders
    // JSON. Only the spelling differs, and the string is read by a model.
    expect(summarizeConversation(INPUT_EVENTS, true)).toBe(
      `user: Can you help me?

helpful_assistant called tool 'get_user_name' with args: null

Tool 'get_user_name' returned: {"name":"John Doe"}

helpful_assistant: Hi John, what can I do for you?`,
    );
  });
});

describe('TestLlmBackedUserSimulator', () => {
  it('test_get_llm_response_return_value', async () => {
    const {simulator, llm} = await simulatorPastOpeningTurn();
    llm.responses.push({
      content: {
        parts: [{text: 'some thought', thought: true}, {text: 'Hello world!'}],
      },
    });

    const next = await simulator.getNextUserMessage(INPUT_EVENTS);

    expect(next.status).toBe(UserSimulatorStatus.SUCCESS);
    expect(next.userMessage).toEqual({
      parts: [{text: 'Hello world!'}],
      role: 'user',
    });
  });

  it('test_get_next_user_message_first_invocation', async () => {
    const llm = new FakeLlm();
    const simulator = new LlmBackedUserSimulator({
      config: {model: FAKE_MODEL},
      conversationScenario: CONVERSATION_SCENARIO,
      llm,
    });

    const next = await simulator.getNextUserMessage([]);

    expect(next.status).toBe(UserSimulatorStatus.SUCCESS);
    expect(next.userMessage).toEqual({
      parts: [{text: CONVERSATION_SCENARIO.startingPrompt}],
      role: 'user',
    });
    expect(llm.requests).toHaveLength(0);
  });

  it('test_turn_limit_reached', async () => {
    const llm = new FakeLlm();
    const simulator = new LlmBackedUserSimulator({
      config: {model: FAKE_MODEL, maxAllowedInvocations: 1},
      conversationScenario: CONVERSATION_SCENARIO,
      llm,
    });
    await simulator.getNextUserMessage([]);

    const next = await simulator.getNextUserMessage(INPUT_EVENTS);

    expect(next.status).toBe(UserSimulatorStatus.TURN_LIMIT_REACHED);
    expect(next.userMessage).toBeUndefined();
    expect(llm.requests).toHaveLength(0);
  });

  it('test_stop_signal_detected', async () => {
    const {simulator, llm} = await simulatorPastOpeningTurn();
    llm.responses.push({content: {parts: [{text: 'Thanks! Bye!</finished>'}]}});

    const next = await simulator.getNextUserMessage(INPUT_EVENTS);

    expect(next.status).toBe(UserSimulatorStatus.STOP_SIGNAL_DETECTED);
    expect(next.userMessage).toBeUndefined();
  });

  it('test_no_message_generated_empty_response', async () => {
    const {simulator} = await simulatorPastOpeningTurn();

    await expect(
      simulator.getNextUserMessage(INPUT_EVENTS),
    ).rejects.toThrowError(
      'Failed to generate a user message: LLM returned empty response',
    );
  });

  it('test_get_next_user_message_safety_blocked', async () => {
    const {simulator, llm} = await simulatorPastOpeningTurn();
    llm.responses.push({
      errorCode: 'SAFETY',
      errorMessage: 'Blocked by safety',
    });

    await expect(
      simulator.getNextUserMessage(INPUT_EVENTS),
    ).rejects.toThrowError(
      'Failed to generate a user message: safety filters or other error' +
        ' (code=SAFETY)',
    );
  });

  it('test_get_next_user_message_thinking_only', async () => {
    const {simulator, llm} = await simulatorPastOpeningTurn();
    llm.responses.push({
      content: {parts: [{text: 'thinking...', thought: true}]},
    });

    await expect(
      simulator.getNextUserMessage(INPUT_EVENTS),
    ).rejects.toThrowError(
      'Failed to generate a user message: LLM returned only thinking tokens',
    );
  });

  it('test_get_next_user_message_success', async () => {
    const {simulator, llm} = await simulatorPastOpeningTurn();
    llm.responses.push({
      content: {parts: [{text: 'I need to book a flight.'}]},
    });

    const next = await simulator.getNextUserMessage(INPUT_EVENTS);

    expect(next.status).toBe(UserSimulatorStatus.SUCCESS);
    expect(next.userMessage).toEqual({
      parts: [{text: 'I need to book a flight.'}],
      role: 'user',
    });
  });

  it('test_get_next_user_message_with_persona_success', async () => {
    const {simulator, llm} = await simulatorPastOpeningTurn(
      CONVERSATION_SCENARIO_WITH_PERSONA,
    );
    llm.responses.push({
      content: {parts: [{text: 'I need to book a flight.'}]},
    });

    const next = await simulator.getNextUserMessage(INPUT_EVENTS);

    expect(next.status).toBe(UserSimulatorStatus.SUCCESS);
    expect(next.userMessage).toEqual({
      parts: [{text: 'I need to book a flight.'}],
      role: 'user',
    });
    const prompt = llm.requests[0].contents[0].parts?.[0].text ?? '';
    expect(prompt).toContain('A test persona');
    expect(prompt).toContain('## polite');
  });
});
