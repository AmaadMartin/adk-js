/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Cases the adk-python reference tests have no reason to cover: the wire
 * aliases adk-js accepts, and `ConversationGenerationConfig`, which adk-python
 * exercises only through its Vertex facade.
 */

import {
  isInputValidationError,
  parseConversationGenerationConfig,
  parseConversationScenario,
  parseConversationScenarios,
} from '@google/adk';
import {describe, expect, it} from 'vitest';

function messageOf(parse: () => unknown): string {
  try {
    parse();
  } catch (error: unknown) {
    if (!isInputValidationError(error)) {
      expect.fail(`expected an InputValidationError, got ${String(error)}`);
    }
    return error.message;
  }
  return expect.fail('expected the parse to throw');
}

describe('ConversationScenario wire aliases', () => {
  it('populates the camelCase properties from snake_case keys', () => {
    const scenario = parseConversationScenario({
      starting_prompt: 'I need to book a flight.',
      conversation_plan: 'Book SFO to LAX.',
      user_persona: 'EXPERT',
    });

    expect(scenario.startingPrompt).toBe('I need to book a flight.');
    expect(scenario.conversationPlan).toBe('Book SFO to LAX.');
    expect(scenario.userPersona?.id).toBe('EXPERT');
  });

  it('normalizes an explicit null persona to undefined', () => {
    const scenario = parseConversationScenario({
      startingPrompt: 'hi',
      conversationPlan: 'chat',
      userPersona: null,
    });

    expect(scenario.userPersona).toBeUndefined();
  });

  it('rejects a persona object whose behavior list is malformed', () => {
    const message = messageOf(() =>
      parseConversationScenario({
        startingPrompt: 'hi',
        conversationPlan: 'chat',
        userPersona: {
          id: 'CUSTOM',
          description: 'Inline persona.',
          behaviors: [{name: 'Be terse'}],
        },
      }),
    );

    expect(message).toContain('userPersona.behaviors.0');
  });

  it('names the missing property when a required field is absent', () => {
    expect(messageOf(() => parseConversationScenario({}))).toContain(
      'startingPrompt',
    );
  });
});

describe('ConversationScenarios', () => {
  it('names the scenario index when a nested scenario is invalid', () => {
    const message = messageOf(() =>
      parseConversationScenarios({
        scenarios: [
          {startingPrompt: 'hi', conversationPlan: 'chat'},
          {
            startingPrompt: 'hi',
            conversationPlan: 'chat',
            userPersonaa: 'EXPERT',
          },
        ],
      }),
    );

    expect(message).toContain('scenarios.1');
    expect(message).toContain('userPersonaa');
  });
});

describe('ConversationGenerationConfig', () => {
  it('round trips every field', () => {
    const config = parseConversationGenerationConfig({
      count: 5,
      generationInstruction: 'Cover the refund flow.',
      environmentContext: 'The catalog holds two models.',
      modelName: 'gemini-2.5-flash',
    });

    expect(config).toEqual({
      count: 5,
      generationInstruction: 'Cover the refund flow.',
      environmentContext: 'The catalog holds two models.',
      modelName: 'gemini-2.5-flash',
    });
  });

  it('populates the camelCase properties from snake_case keys', () => {
    const config = parseConversationGenerationConfig({
      count: 2,
      generation_instruction: 'Cover the refund flow.',
      environment_context: 'The catalog holds two models.',
      model_name: 'gemini-2.5-flash',
    });

    expect(config.generationInstruction).toBe('Cover the refund flow.');
    expect(config.environmentContext).toBe('The catalog holds two models.');
    expect(config.modelName).toBe('gemini-2.5-flash');
  });

  it('leaves both optional fields undefined when they are absent', () => {
    const config = parseConversationGenerationConfig({
      count: 1,
      modelName: 'gemini-2.5-flash',
    });

    expect(config.generationInstruction).toBeUndefined();
    expect(config.environmentContext).toBeUndefined();
  });

  it('requires count', () => {
    expect(
      messageOf(() =>
        parseConversationGenerationConfig({modelName: 'gemini-2.5-flash'}),
      ),
    ).toContain('count');
  });

  it('requires modelName', () => {
    expect(
      messageOf(() => parseConversationGenerationConfig({count: 3})),
    ).toContain('modelName');
  });

  it('rejects a non-integer count', () => {
    expect(
      messageOf(() =>
        parseConversationGenerationConfig({
          count: 2.5,
          modelName: 'gemini-2.5-flash',
        }),
      ),
    ).toContain('count');
  });
});
