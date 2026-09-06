/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Cases adk-python gets from pydantic and does not test itself: the wire
 * spelling of every field, the error each malformed document produces, and the
 * non-throwing entry point.
 */

import {
  conversationGenerationConfigModel,
  conversationScenarioModel,
  conversationScenariosModel,
  InputValidationError,
  isInputValidationError,
} from '@google/adk';
import {describe, expect, it} from 'vitest';

function expectValidationError(run: () => unknown): InputValidationError {
  try {
    run();
  } catch (error: unknown) {
    if (isInputValidationError(error)) {
      return error;
    }
    expect.fail(`Expected an InputValidationError, got ${String(error)}.`);
  }
  expect.fail('Expected an InputValidationError, but nothing was thrown.');
}

describe('conversationScenarioModel', () => {
  it('names the missing required field', () => {
    expect(
      expectValidationError(() =>
        conversationScenarioModel.parse({conversationPlan: 'chat'}),
      ).message,
    ).toContain('startingPrompt');

    expect(
      expectValidationError(() =>
        conversationScenarioModel.parse({startingPrompt: 'hi'}),
      ).message,
    ).toContain('conversationPlan');
  });

  it('rejects a persona that is neither an id nor a persona', () => {
    expect(
      expectValidationError(() =>
        conversationScenarioModel.parse({
          startingPrompt: 'hi',
          conversationPlan: 'chat',
          userPersona: 42,
        }),
      ).message,
    ).toContain('userPersona');
  });

  it('rejects a persona object missing a required field', () => {
    expect(
      expectValidationError(() =>
        conversationScenarioModel.parse({
          startingPrompt: 'hi',
          conversationPlan: 'chat',
          userPersona: {id: 'CUSTOM', description: 'no behaviors listed'},
        }),
      ).message,
    ).toContain('userPersona');
  });

  it('rejects a persona object whose behavior list is malformed', () => {
    expect(
      expectValidationError(() =>
        conversationScenarioModel.parse({
          startingPrompt: 'hi',
          conversationPlan: 'chat',
          userPersona: {
            id: 'CUSTOM',
            description: 'Inline persona.',
            behaviors: [{name: 'Be terse'}],
          },
        }),
      ).message,
    ).toContain('userPersona');
  });

  it('accepts the adk-python snake_case spelling', () => {
    const scenario = conversationScenarioModel.parse({
      starting_prompt: 'I need to book a flight.',
      conversation_plan: 'Book SFO to LAX.',
      user_persona: 'EXPERT',
    });

    expect(scenario.startingPrompt).toBe('I need to book a flight.');
    expect(scenario.conversationPlan).toBe('Book SFO to LAX.');
    expect(scenario.userPersona?.id).toBe('EXPERT');
  });

  it('reads an explicit null persona as absent', () => {
    const scenario = conversationScenarioModel.parse({
      startingPrompt: 'hi',
      conversationPlan: 'chat',
      userPersona: null,
    });

    expect(scenario.userPersona).toBeUndefined();
    expect(JSON.parse(JSON.stringify(scenario))).toEqual({
      startingPrompt: 'hi',
      conversationPlan: 'chat',
    });
  });

  it('keeps camelCase on the value and dumps snake_case by alias', () => {
    const scenario = conversationScenarioModel.parse({
      startingPrompt: 'hi',
      conversationPlan: 'chat',
      userPersona: 'EXPERT',
    });

    expect(Object.keys(scenario)).toEqual([
      'startingPrompt',
      'conversationPlan',
      'userPersona',
    ]);

    const byAlias = conversationScenarioModel.dump(scenario, {byAlias: true});
    expect(Object.keys(byAlias)).toEqual([
      'starting_prompt',
      'conversation_plan',
      'user_persona',
    ]);
    expect(byAlias['user_persona']).toEqual({
      id: 'EXPERT',
      description: expect.any(String),
      behaviors: expect.any(Array),
    });
  });
});

describe('conversationScenariosModel', () => {
  it('names the offending scenario and key of a nested failure', () => {
    const error = expectValidationError(() =>
      conversationScenariosModel.parse({
        scenarios: [
          {startingPrompt: 'hi', conversationPlan: 'chat'},
          {startingPrompt: 'hi', conversationPlan: 'chat', persona: 'EXPERT'},
        ],
      }),
    );

    expect(error.message).toContain('scenarios.1');
    expect(error.message).toContain('persona');
  });

  it('reports a bad document through safeParse instead of throwing', () => {
    const result = conversationScenariosModel.schema.safeParse({
      scenarios: [{startingPrompt: 'hi'}],
    });

    expect(result.success).toBe(false);
  });
});

describe('conversationGenerationConfigModel', () => {
  it('reads every field', () => {
    expect(
      conversationGenerationConfigModel.parse({
        count: 5,
        generationInstruction: 'Cover the refund flow.',
        environmentContext: 'The catalog holds two models.',
        modelName: 'gemini-2.5-flash',
      }),
    ).toEqual({
      count: 5,
      generationInstruction: 'Cover the refund flow.',
      environmentContext: 'The catalog holds two models.',
      modelName: 'gemini-2.5-flash',
    });
  });

  it('leaves both optional fields out when they are absent or null', () => {
    const absent = conversationGenerationConfigModel.parse({
      count: 1,
      modelName: 'gemini-2.5-flash',
    });
    const explicitNull = conversationGenerationConfigModel.parse({
      count: 1,
      modelName: 'gemini-2.5-flash',
      generationInstruction: null,
      environmentContext: null,
    });

    expect(absent).toEqual({count: 1, modelName: 'gemini-2.5-flash'});
    expect(explicitNull).toEqual(absent);
    expect(explicitNull.generationInstruction).toBeUndefined();
    expect(explicitNull.environmentContext).toBeUndefined();
  });

  it('accepts the adk-python snake_case spelling', () => {
    expect(
      conversationGenerationConfigModel.parse({
        count: 2,
        generation_instruction: 'Cover the refund flow.',
        environment_context: 'The catalog holds two models.',
        model_name: 'gemini-2.5-flash',
      }),
    ).toEqual({
      count: 2,
      generationInstruction: 'Cover the refund flow.',
      environmentContext: 'The catalog holds two models.',
      modelName: 'gemini-2.5-flash',
    });
  });

  it('dumps snake_case by alias', () => {
    const config = conversationGenerationConfigModel.parse({
      count: 2,
      generationInstruction: 'Cover the refund flow.',
      modelName: 'gemini-2.5-flash',
    });

    expect(
      conversationGenerationConfigModel.dump(config, {byAlias: true}),
    ).toEqual({
      count: 2,
      generation_instruction: 'Cover the refund flow.',
      model_name: 'gemini-2.5-flash',
    });
  });

  it('names the missing required field', () => {
    expect(
      expectValidationError(() =>
        conversationGenerationConfigModel.parse({
          modelName: 'gemini-2.5-flash',
        }),
      ).message,
    ).toContain('count');

    expect(
      expectValidationError(() =>
        conversationGenerationConfigModel.parse({count: 1}),
      ).message,
    ).toContain('modelName');
  });

  it('rejects a non-integer count', () => {
    expect(
      expectValidationError(() =>
        conversationGenerationConfigModel.parse({
          count: 2.5,
          modelName: 'gemini-2.5-flash',
        }),
      ).message,
    ).toContain('count');
  });

  it('rejects an unknown key', () => {
    expect(
      expectValidationError(() =>
        conversationGenerationConfigModel.parse({
          count: 1,
          modelName: 'gemini-2.5-flash',
          temperature: 0.2,
        }),
      ).message,
    ).toContain('temperature');
  });
});
