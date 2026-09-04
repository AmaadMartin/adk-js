/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

// Ported from adk-python
// tests/unittests/evaluation/simulation/test_llm_backed_user_simulator.py (main).

import {
  BaseLlm,
  BaseLlmConnection,
  ConversationScenario,
  Event,
  LLMRegistry,
  LlmBackedUserSimulator,
  LlmRequest,
  LlmResponse,
  UserPersona,
  UserSimulatorStatus,
  createEvent,
  parseLlmBackedUserSimulatorConfig,
  validateNextUserMessage,
} from '@google/adk';
import {GenerateContentConfig, Schema, Type} from '@google/genai';
import {describe, expect, it} from 'vitest';

import {summarizeConversation} from '../../../src/evaluation/simulation/llm_backed_user_simulator.js';

/** A model that replays scripted responses and records what it was sent. */
class FakeLlm extends BaseLlm {
  readonly requests: LlmRequest[] = [];

  constructor(
    private readonly responses: LlmResponse[] = [],
    model = 'test-model',
  ) {
    super({model});
  }

  async *generateContentAsync(
    llmRequest: LlmRequest,
  ): AsyncGenerator<LlmResponse, void> {
    this.requests.push(llmRequest);
    for (const response of this.responses) {
      yield response;
    }
  }

  async connect(_llmRequest: LlmRequest): Promise<BaseLlmConnection> {
    throw new Error('Method not implemented.');
  }
}

/** A model the registry can resolve, so the fallback path is reachable. */
class RegistryFakeLlm extends FakeLlm {
  static override readonly supportedModels = ['registry-fake-model'];

  constructor(params: {model: string}) {
    super([], params.model);
  }
}

const INPUT_EVENTS: Event[] = [
  createEvent({
    author: 'user',
    invocationId: 'inv1',
    content: {role: 'user', parts: [{text: 'Can you help me?'}]},
  }),
  createEvent({
    author: 'helpful_assistant',
    invocationId: 'inv1',
    content: {
      role: 'model',
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
    },
  }),
];

const INPUT_EVENTS_LONG: Event[] = [
  ...INPUT_EVENTS,
  createEvent({
    author: 'user',
    invocationId: 'inv2',
    content: {role: 'user', parts: [{text: 'I need to book a flight.'}]},
  }),
  createEvent({
    author: 'helpful_assistant',
    invocationId: 'inv2',
    content: {
      role: 'model',
      parts: [{text: 'Sure, what is your departure date and destination?'}],
    },
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

/**
 * Builds a simulator whose next turn goes to the model.
 *
 * adk-python's fixtures set the private invocation count to 1 to skip the
 * fixed starting prompt. Here the first turn is taken through the public API,
 * which is what advances the count.
 */
async function simulatorPastStartingPrompt(options: {
  llm: FakeLlm;
  conversationScenario?: ConversationScenario;
}): Promise<LlmBackedUserSimulator> {
  const simulator = new LlmBackedUserSimulator({
    config: {model: 'test-model'},
    conversationScenario: options.conversationScenario ?? CONVERSATION_SCENARIO,
    llm: options.llm,
  });
  const first = await simulator.getNextUserMessage([]);
  expect(first.status).toBe(UserSimulatorStatus.SUCCESS);
  return simulator;
}

describe('parseLlmBackedUserSimulatorConfig', () => {
  // Ports test_llm_backed_user_simulator_config_validation.
  it('accepts a config that names no custom instructions', () => {
    const config = parseLlmBackedUserSimulatorConfig({});

    expect(config.customInstructions).toBeUndefined();
    expect(config.type).toBe('llm_backed');
    expect(config.model).toBe('gemini-2.5-flash');
    expect(config.maxAllowedInvocations).toBe(20);
    expect(config.includeFunctionCalls).toBe(false);
    expect(config.modelConfiguration).toEqual({
      thinkingConfig: {includeThoughts: true, thinkingBudget: 10240},
    });
  });

  // Ports test_llm_backed_user_simulator_config_validation.
  it('accepts custom instructions that carry every placeholder', () => {
    const customInstructions =
      '{{ stop_signal }} {{ conversation_plan }} {{ conversation_history }}';

    const config = parseLlmBackedUserSimulatorConfig({customInstructions});

    expect(config.customInstructions).toBe(customInstructions);
  });

  // Ports test_llm_backed_user_simulator_config_validation.
  it('rejects custom instructions that miss a placeholder', () => {
    expect(() =>
      parseLlmBackedUserSimulatorConfig({
        customInstructions: 'Instructions with missing formatting placeholders',
      }),
    ).toThrowError(
      /custom_instructions must contain each of the following formatting placeholders using Jinja syntax: \{\{ stop_signal \}\}, \{\{ conversation_plan \}\}, \{\{ conversation_history \}\}/,
    );
  });

  it('reads the snake_case spelling adk-python writes', () => {
    const config = parseLlmBackedUserSimulatorConfig({
      max_allowed_invocations: 3,
      include_function_calls: true,
    });

    expect(config.maxAllowedInvocations).toBe(3);
    expect(config.includeFunctionCalls).toBe(true);
  });

  it('rejects a model configuration that is not an object', () => {
    expect(() =>
      parseLlmBackedUserSimulatorConfig({modelConfiguration: 'flash'}),
    ).toThrowError(/must be a GenerateContentConfig/);
  });

  it('rejects a null model configuration', () => {
    expect(() =>
      parseLlmBackedUserSimulatorConfig({modelConfiguration: null}),
    ).toThrowError(/must be a GenerateContentConfig/);
  });

  it('gives each config its own default model configuration', () => {
    const first = parseLlmBackedUserSimulatorConfig({});
    const second = parseLlmBackedUserSimulatorConfig({});

    expect(first.modelConfiguration).not.toBe(second.modelConfiguration);
  });

  it('passes the model configuration through untouched', () => {
    const abortSignal = AbortSignal.timeout(1000);
    const responseSchema: Schema = {
      properties: {my_field: {type: Type.STRING}},
    };
    const modelConfiguration: GenerateContentConfig = {
      labels: {my_key: 'my value'},
      responseSchema,
      abortSignal,
    };

    const config = parseLlmBackedUserSimulatorConfig({modelConfiguration});

    // Same object, so no key inside it was rewritten and no instance was
    // rebuilt as a plain object.
    expect(config.modelConfiguration).toBe(modelConfiguration);
    expect(config.modelConfiguration.labels).toEqual({my_key: 'my value'});
    expect(config.modelConfiguration.responseSchema).toBe(responseSchema);
    expect(config.modelConfiguration.abortSignal).toBe(abortSignal);
  });

  it('passes a snake_case model configuration through untouched', () => {
    const modelConfiguration: GenerateContentConfig = {
      labels: {my_key: 'my value'},
    };

    const config = parseLlmBackedUserSimulatorConfig({
      model_configuration: modelConfiguration,
    });

    expect(config.modelConfiguration).toBe(modelConfiguration);
    expect(config.modelConfiguration.labels).toEqual({my_key: 'my value'});
  });
});

describe('summarizeConversation', () => {
  // Ports test_convert_conversation_to_user_sim_pov.
  it('keeps the spoken turns and drops thoughts and tool traffic', () => {
    expect(summarizeConversation(INPUT_EVENTS)).toBe(
      EXPECTED_REWRITTEN_DIALOGUE,
    );
    expect(summarizeConversation(INPUT_EVENTS_LONG)).toBe(
      EXPECTED_REWRITTEN_DIALOGUE_LONG,
    );
  });

  // Ports test_summarize_conversation_with_function_calls. adk-python renders
  // the arguments with Python's repr, so it expects `None` and
  // `{'name': 'John Doe'}`; this port renders them as JSON.
  it('includes tool calls and results when asked to', () => {
    expect(summarizeConversation(INPUT_EVENTS, true)).toBe(
      [
        'user: Can you help me?',
        "helpful_assistant called tool 'get_user_name' with args: undefined",
        `Tool 'get_user_name' returned: {"name":"John Doe"}`,
        'helpful_assistant: Hi John, what can I do for you?',
      ].join('\n\n'),
    );
  });

  it('skips an event that carries no content', () => {
    const events = [createEvent({author: 'user', invocationId: 'inv1'})];

    expect(summarizeConversation(events)).toBe('');
  });

  it('labels an event that names no author', () => {
    const events = [
      createEvent({
        invocationId: 'inv1',
        content: {role: 'model', parts: [{text: 'unattributed'}]},
      }),
    ];

    expect(summarizeConversation(events)).toBe('agent: unattributed');
  });

  it('drops a tool call the caller did not ask to see', () => {
    const events = [
      createEvent({
        author: 'helpful_assistant',
        invocationId: 'inv1',
        content: {role: 'model', parts: [{functionCall: {name: 'noop'}}]},
      }),
    ];

    expect(summarizeConversation(events, false)).toBe('');
  });

  it('drops a part that carries nothing it can render', () => {
    const events = [
      createEvent({
        author: 'helpful_assistant',
        invocationId: 'inv1',
        content: {
          role: 'model',
          parts: [{inlineData: {mimeType: 'image/png'}}],
        },
      }),
    ];

    expect(summarizeConversation(events, true)).toBe('');
  });
});

describe('LlmBackedUserSimulator', () => {
  // Ports test_get_next_user_message_first_invocation.
  it('returns the starting prompt without calling the model', async () => {
    const llm = new FakeLlm();
    const simulator = new LlmBackedUserSimulator({
      config: {model: 'test-model'},
      conversationScenario: CONVERSATION_SCENARIO,
      llm,
    });

    const next = await simulator.getNextUserMessage([]);

    expect(next.status).toBe(UserSimulatorStatus.SUCCESS);
    expect(next.userMessage).toEqual({
      role: 'user',
      parts: [{text: 'Hello'}],
    });
    expect(llm.requests).toHaveLength(0);
  });

  // Ports test_get_llm_response_return_value.
  it('returns the spoken text and drops the thoughts around it', async () => {
    const llm = new FakeLlm([
      {
        content: {
          parts: [
            {text: 'some thought', thought: true},
            {text: 'Hello world!'},
          ],
        },
      },
    ]);
    const simulator = await simulatorPastStartingPrompt({llm});

    const next = await simulator.getNextUserMessage([]);

    expect(next.status).toBe(UserSimulatorStatus.SUCCESS);
    expect(next.userMessage?.parts?.[0].text).toBe('Hello world!');
  });

  // Ports test_turn_limit_reached.
  it('stops once the invocation limit is reached', async () => {
    const llm = new FakeLlm();
    const simulator = new LlmBackedUserSimulator({
      config: {maxAllowedInvocations: 1},
      conversationScenario: CONVERSATION_SCENARIO,
      llm,
    });

    const first = await simulator.getNextUserMessage(INPUT_EVENTS);
    const second = await simulator.getNextUserMessage(INPUT_EVENTS);

    expect(first.status).toBe(UserSimulatorStatus.SUCCESS);
    expect(second).toEqual({status: UserSimulatorStatus.TURN_LIMIT_REACHED});
    expect(llm.requests).toHaveLength(0);
    validateNextUserMessage(second);
  });

  it('takes no turn at all when the limit is zero', async () => {
    const llm = new FakeLlm();
    const simulator = new LlmBackedUserSimulator({
      config: {maxAllowedInvocations: 0},
      conversationScenario: CONVERSATION_SCENARIO,
      llm,
    });

    expect(await simulator.getNextUserMessage([])).toEqual({
      status: UserSimulatorStatus.TURN_LIMIT_REACHED,
    });
  });

  it('keeps going past the default budget when the limit is -1', async () => {
    const llm = new FakeLlm([{content: {parts: [{text: 'still here'}]}}]);
    const simulator = new LlmBackedUserSimulator({
      config: {maxAllowedInvocations: -1},
      conversationScenario: CONVERSATION_SCENARIO,
      llm,
    });

    let last = await simulator.getNextUserMessage([]);
    for (let turn = 0; turn < 21; turn++) {
      last = await simulator.getNextUserMessage(INPUT_EVENTS);
    }

    expect(last.status).toBe(UserSimulatorStatus.SUCCESS);
    expect(llm.requests).toHaveLength(21);
  });

  // Ports test_stop_signal_detected.
  it('stops when the model emits the stop signal', async () => {
    const llm = new FakeLlm([
      {content: {parts: [{text: 'Thanks! Bye!</finished>'}]}},
    ]);
    const simulator = await simulatorPastStartingPrompt({llm});

    const next = await simulator.getNextUserMessage(INPUT_EVENTS);

    expect(next).toEqual({status: UserSimulatorStatus.STOP_SIGNAL_DETECTED});
    validateNextUserMessage(next);
  });

  it('matches the stop signal whatever its case', async () => {
    const llm = new FakeLlm([
      {content: {parts: [{text: 'Thanks! Bye!</FINISHED>'}]}},
    ]);
    const simulator = await simulatorPastStartingPrompt({llm});

    const next = await simulator.getNextUserMessage(INPUT_EVENTS);

    expect(next).toEqual({status: UserSimulatorStatus.STOP_SIGNAL_DETECTED});
  });

  // Ports test_no_message_generated_empty_response.
  it('fails when the model stream yields nothing', async () => {
    const llm = new FakeLlm([]);
    const simulator = await simulatorPastStartingPrompt({llm});

    await expect(
      simulator.getNextUserMessage(INPUT_EVENTS),
    ).rejects.toThrowError(
      'Failed to generate a user message: LLM returned empty response',
    );
  });

  it('fails when the model yields a response that carries no parts', async () => {
    const llm = new FakeLlm([{content: {parts: []}}, {}]);
    const simulator = await simulatorPastStartingPrompt({llm});

    await expect(
      simulator.getNextUserMessage(INPUT_EVENTS),
    ).rejects.toThrowError(
      'Failed to generate a user message: LLM returned empty response',
    );
  });

  // Ports test_get_next_user_message_safety_blocked.
  it('fails when the model reports an error code', async () => {
    const llm = new FakeLlm([
      {errorCode: 'SAFETY', errorMessage: 'Blocked by safety'},
      {content: {parts: [{text: 'never read'}]}},
    ]);
    const simulator = await simulatorPastStartingPrompt({llm});

    await expect(
      simulator.getNextUserMessage(INPUT_EVENTS),
    ).rejects.toThrowError(
      'Failed to generate a user message: safety filters or other error (code=SAFETY)',
    );
  });

  it('discards the text collected before the error code', async () => {
    const llm = new FakeLlm([
      {content: {parts: [{text: 'half a sentence'}]}},
      {errorCode: 'SAFETY'},
    ]);
    const simulator = await simulatorPastStartingPrompt({llm});

    await expect(
      simulator.getNextUserMessage(INPUT_EVENTS),
    ).rejects.toThrowError(
      'Failed to generate a user message: safety filters or other error (code=SAFETY)',
    );
  });

  // Ports test_get_next_user_message_thinking_only.
  it('fails when the model returns only thoughts', async () => {
    const llm = new FakeLlm([
      {content: {parts: [{text: 'thinking...', thought: true}]}},
    ]);
    const simulator = await simulatorPastStartingPrompt({llm});

    await expect(
      simulator.getNextUserMessage(INPUT_EVENTS),
    ).rejects.toThrowError(
      'Failed to generate a user message: LLM returned only thinking tokens',
    );
  });

  // Ports test_get_next_user_message_success.
  it('returns the message the model produced', async () => {
    const llm = new FakeLlm([
      {content: {parts: [{text: 'I need to book a flight.'}]}},
    ]);
    const simulator = await simulatorPastStartingPrompt({llm});

    const next = await simulator.getNextUserMessage(INPUT_EVENTS);

    expect(next.status).toBe(UserSimulatorStatus.SUCCESS);
    expect(next.userMessage).toEqual({
      role: 'user',
      parts: [{text: 'I need to book a flight.'}],
    });
    validateNextUserMessage(next);
  });

  it('joins the text of a streamed response', async () => {
    const llm = new FakeLlm([
      {content: {parts: [{text: 'I need to '}]}},
      {content: {parts: [{text: 'book a flight.'}]}},
    ]);
    const simulator = await simulatorPastStartingPrompt({llm});

    const next = await simulator.getNextUserMessage(INPUT_EVENTS);

    expect(next.userMessage?.parts?.[0].text).toBe('I need to book a flight.');
  });

  // Ports test_get_next_user_message_with_persona_success.
  it('returns the message the model produced for a persona', async () => {
    const llm = new FakeLlm([
      {content: {parts: [{text: 'I need to book a flight.'}]}},
    ]);
    const simulator = await simulatorPastStartingPrompt({
      llm,
      conversationScenario: {
        startingPrompt: 'Hello',
        conversationPlan: 'test plan with persona',
        userPersona: USER_PERSONA,
      },
    });

    const next = await simulator.getNextUserMessage(INPUT_EVENTS);

    expect(next.status).toBe(UserSimulatorStatus.SUCCESS);
    expect(next.userMessage).toEqual({
      role: 'user',
      parts: [{text: 'I need to book a flight.'}],
    });
    const prompt = llm.requests[0].contents[0].parts?.[0].text;
    expect(prompt).toContain('A test persona');
    expect(prompt).toContain('  * Always say please and thank you.');
  });

  it('sends the plan, the history and the stop signal to the model', async () => {
    const llm = new FakeLlm([{content: {parts: [{text: 'go on'}]}}]);
    const simulator = await simulatorPastStartingPrompt({llm});

    await simulator.getNextUserMessage(INPUT_EVENTS);

    const request = llm.requests[0];
    expect(request.model).toBe('test-model');
    const prompt = request.contents[0].parts?.[0].text;
    expect(prompt).toContain('test plan');
    expect(prompt).toContain(EXPECTED_REWRITTEN_DIALOGUE);
    expect(prompt).toContain('</finished>');
  });

  it('stamps the default retry policy on the request', async () => {
    const llm = new FakeLlm([{content: {parts: [{text: 'go on'}]}}]);
    const simulator = await simulatorPastStartingPrompt({llm});

    await simulator.getNextUserMessage(INPUT_EVENTS);

    expect(
      llm.requests[0].config?.httpOptions?.retryOptions?.attempts,
    ).toBeGreaterThan(1);
  });

  it('shows the model the tool traffic when the config asks for it', async () => {
    const llm = new FakeLlm([{content: {parts: [{text: 'go on'}]}}]);
    const simulator = new LlmBackedUserSimulator({
      config: {includeFunctionCalls: true},
      conversationScenario: CONVERSATION_SCENARIO,
      llm,
    });

    await simulator.getNextUserMessage([]);
    await simulator.getNextUserMessage(INPUT_EVENTS);

    expect(llm.requests[0].contents[0].parts?.[0].text).toContain(
      "helpful_assistant called tool 'get_user_name'",
    );
  });

  it('rejects a config it cannot validate', () => {
    expect(
      () =>
        new LlmBackedUserSimulator({
          config: {customInstructions: 'no placeholders here'},
          conversationScenario: CONVERSATION_SCENARIO,
          llm: new FakeLlm(),
        }),
    ).toThrowError(/custom_instructions must contain/);
  });

  it('resolves the model from the registry when none is given', async () => {
    LLMRegistry.register(RegistryFakeLlm);
    const simulator = new LlmBackedUserSimulator({
      config: {model: 'registry-fake-model'},
      conversationScenario: CONVERSATION_SCENARIO,
    });

    const first = await simulator.getNextUserMessage([]);

    expect(first.userMessage?.parts?.[0].text).toBe('Hello');
    // The registered model yields nothing, so the second turn proves the
    // simulator called the model the registry resolved.
    await expect(simulator.getNextUserMessage([])).rejects.toThrowError(
      'Failed to generate a user message: LLM returned empty response',
    );
  });
});
