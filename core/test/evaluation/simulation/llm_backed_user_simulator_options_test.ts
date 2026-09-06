/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Covers the options and the renderings of
 * `core/src/evaluation/simulation/llm_backed_user_simulator.ts` that
 * google/adk-python's own tests leave untested.
 */

import {
  BaseLlm,
  createEvent,
  LlmBackedUserSimulator,
  LLMRegistry,
  summarizeConversation,
  UserSimulatorStatus,
  type BaseLlmConnection,
  type ConversationScenario,
  type LlmBackedUserSimulatorConfig,
  type LlmResponse,
} from '@google/adk';
import {beforeAll, describe, expect, it} from 'vitest';

import {FAKE_MODEL, FakeLlm} from './fake_llm.js';

const REGISTERED_MODEL = 'registry-user-simulator-llm';
const REGISTERED_MODEL_REPLY = 'answer from the registered model';

/** A model reachable only through {@link LLMRegistry}. */
class RegisteredFakeLlm extends BaseLlm {
  static override readonly supportedModels = [REGISTERED_MODEL];

  override async *generateContentAsync(): AsyncGenerator<LlmResponse, void> {
    yield {content: {parts: [{text: REGISTERED_MODEL_REPLY}]}};
  }

  override async connect(): Promise<BaseLlmConnection> {
    throw new Error('RegisteredFakeLlm does not support live connections.');
  }
}

const CONVERSATION_SCENARIO: ConversationScenario = {
  startingPrompt: 'Hello',
  conversationPlan: 'test plan',
};

/** Builds a simulator over a {@link FakeLlm} and plays its opening turn. */
async function simulatorPastOpeningTurn(
  config: LlmBackedUserSimulatorConfig,
): Promise<{simulator: LlmBackedUserSimulator; llm: FakeLlm}> {
  const llm = new FakeLlm();
  const simulator = new LlmBackedUserSimulator({
    config,
    conversationScenario: CONVERSATION_SCENARIO,
    llm,
  });
  await simulator.getNextUserMessage([]);
  return {simulator, llm};
}

describe('maxAllowedInvocations', () => {
  it('never reaches the limit when it is -1', async () => {
    const {simulator, llm} = await simulatorPastOpeningTurn({
      model: FAKE_MODEL,
      maxAllowedInvocations: -1,
    });
    llm.responses.push({content: {parts: [{text: 'still going'}]}});

    for (let turn = 0; turn < 3; turn++) {
      const next = await simulator.getNextUserMessage([]);
      expect(next.status).toBe(UserSimulatorStatus.SUCCESS);
    }
  });

  it('counts the opening turn against the limit', async () => {
    const simulator = new LlmBackedUserSimulator({
      config: {model: FAKE_MODEL, maxAllowedInvocations: 0},
      conversationScenario: CONVERSATION_SCENARIO,
      llm: new FakeLlm(),
    });

    const next = await simulator.getNextUserMessage([]);

    expect(next.status).toBe(UserSimulatorStatus.TURN_LIMIT_REACHED);
  });
});

describe('model resolution', () => {
  beforeAll(() => {
    LLMRegistry.register(RegisteredFakeLlm);
  });

  it('resolves the configured model when no model is injected', async () => {
    const simulator = new LlmBackedUserSimulator({
      config: {model: REGISTERED_MODEL},
      conversationScenario: CONVERSATION_SCENARIO,
    });
    await simulator.getNextUserMessage([]);

    const next = await simulator.getNextUserMessage([]);

    expect(next.userMessage).toEqual({
      parts: [{text: REGISTERED_MODEL_REPLY}],
      role: 'user',
    });
  });
});

describe('modelConfiguration', () => {
  it('gives each simulator its own default configuration', async () => {
    const first = await simulatorPastOpeningTurn({model: FAKE_MODEL});
    const second = await simulatorPastOpeningTurn({model: FAKE_MODEL});
    first.llm.responses.push({content: {parts: [{text: 'one'}]}});
    second.llm.responses.push({content: {parts: [{text: 'two'}]}});

    await first.simulator.getNextUserMessage([]);
    await second.simulator.getNextUserMessage([]);

    const firstConfig = first.llm.requests[0].config;
    const secondConfig = second.llm.requests[0].config;
    expect(firstConfig?.httpOptions?.retryOptions).toBeDefined();
    // A shared default object would make the retry policy one simulator
    // acquired visible to every other simulator.
    expect(firstConfig).not.toBe(secondConfig);
    expect(firstConfig?.thinkingConfig?.includeThoughts).toBe(true);
  });

  it('sends the configuration the caller gave', async () => {
    const {simulator, llm} = await simulatorPastOpeningTurn({
      model: FAKE_MODEL,
      modelConfiguration: {temperature: 0.25},
    });
    llm.responses.push({content: {parts: [{text: 'answer'}]}});

    await simulator.getNextUserMessage([]);

    expect(llm.requests[0].model).toBe(FAKE_MODEL);
    expect(llm.requests[0].config?.temperature).toBe(0.25);
    expect(llm.requests[0].config?.thinkingConfig).toBeUndefined();
  });
});

describe('prompt inputs', () => {
  it('sends the custom instructions the caller gave', async () => {
    const {simulator, llm} = await simulatorPastOpeningTurn({
      model: FAKE_MODEL,
      customInstructions:
        'Say {{ stop_signal }} after {{ conversation_plan }}:' +
        ' {{ conversation_history }}',
    });
    llm.responses.push({content: {parts: [{text: 'answer'}]}});

    await simulator.getNextUserMessage([
      createEvent({
        author: 'user',
        content: {parts: [{text: 'hi there'}], role: 'user'},
      }),
    ]);

    expect(llm.requests[0].contents[0].parts?.[0].text).toBe(
      'Say </finished> after test plan: user: hi there',
    );
  });

  it('sends the function calls when includeFunctionCalls is set', async () => {
    const {simulator, llm} = await simulatorPastOpeningTurn({
      model: FAKE_MODEL,
      includeFunctionCalls: true,
    });
    llm.responses.push({content: {parts: [{text: 'answer'}]}});

    await simulator.getNextUserMessage([
      createEvent({
        author: 'agent',
        content: {
          parts: [{functionCall: {name: 'get_weather'}}],
          role: 'model',
        },
      }),
    ]);

    expect(llm.requests[0].contents[0].parts?.[0].text).toContain(
      "agent called tool 'get_weather' with args: null",
    );
  });
});

describe('model stream handling', () => {
  it('reports an error code that carries no message', async () => {
    const {simulator, llm} = await simulatorPastOpeningTurn({
      model: FAKE_MODEL,
    });
    llm.responses.push({errorCode: 'RECITATION'});

    await expect(simulator.getNextUserMessage([])).rejects.toThrowError(
      'Failed to generate a user message: safety filters or other error' +
        ' (code=RECITATION)',
    );
  });

  it('skips a chunk that carries no parts', async () => {
    const {simulator, llm} = await simulatorPastOpeningTurn({
      model: FAKE_MODEL,
    });
    llm.responses.push(
      {},
      {content: {role: 'model'}},
      {content: {parts: [{text: 'the answer'}], role: 'model'}},
    );

    const next = await simulator.getNextUserMessage([]);

    expect(next.userMessage).toEqual({
      parts: [{text: 'the answer'}],
      role: 'user',
    });
  });
});

describe('stop signal', () => {
  it('detects a stop signal written in another case', async () => {
    const {simulator, llm} = await simulatorPastOpeningTurn({
      model: FAKE_MODEL,
    });
    llm.responses.push({content: {parts: [{text: 'Bye!</FINISHED>'}]}});

    const next = await simulator.getNextUserMessage([]);

    expect(next.status).toBe(UserSimulatorStatus.STOP_SIGNAL_DETECTED);
    expect(next.userMessage).toBeUndefined();
  });
});

describe('summarizeConversation', () => {
  it('skips an event that carries no parts', () => {
    const events = [
      createEvent({author: 'user'}),
      createEvent({author: 'agent', content: {role: 'model'}}),
      createEvent({
        author: 'user',
        content: {parts: [{text: 'the only turn'}], role: 'user'},
      }),
    ];

    expect(summarizeConversation(events)).toBe('user: the only turn');
  });

  it('renders a tool response that carries no payload', () => {
    const events = [
      createEvent({
        author: 'agent',
        content: {
          parts: [{functionResponse: {name: 'notify'}}],
          role: 'model',
        },
      }),
    ];

    expect(summarizeConversation(events, true)).toBe(
      "Tool 'notify' returned: null",
    );
  });

  it('renders a tool argument as json', () => {
    const events = [
      createEvent({
        author: 'agent',
        content: {
          parts: [
            {
              functionCall: {
                name: 'book',
                args: {
                  seats: 2,
                  tags: ['aisle', 'window'],
                  refundable: true,
                  note: null,
                  passenger: {name: 'Ada'},
                },
              },
            },
          ],
          role: 'model',
        },
      }),
    ];

    expect(summarizeConversation(events, true)).toBe(
      `agent called tool 'book' with args: {"seats":2,"tags":["aisle",` +
        `"window"],"refundable":true,"note":null,"passenger":{"name":"Ada"}}`,
    );
  });
});
