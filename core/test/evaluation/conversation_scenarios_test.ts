/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Ported from adk-python
 * `tests/unittests/evaluation/test_conversation_scenarios.py`, at commit
 * c7ffcfa85a8e8970f6318306479d9c4c110583b2. Each `it()` keeps the Python test
 * name so the two suites stay greppable against each other.
 */

import {
  conversationScenarioModel,
  conversationScenariosModel,
  getDefaultPersonaRegistry,
  InputValidationError,
  NotFoundError,
  type ConversationScenarios,
  type UserPersona,
} from '@google/adk';
import {describe, expect, it} from 'vitest';

function customPersona(): UserPersona {
  return {
    id: 'CUSTOM',
    description: 'A persona defined inline by the eval author.',
    behaviors: [
      {
        name: 'Be terse',
        description: 'Answers in as few words as possible.',
        behaviorInstructions: ['Reply with at most five words.'],
        violationRubrics: ['The reply rambles.'],
      },
    ],
  };
}

describe('ConversationScenario', () => {
  it('test_user_persona_given_as_id_resolves_to_default_persona', () => {
    const scenario = conversationScenarioModel.parse({
      startingPrompt: 'I need to book a flight.',
      conversationPlan: 'Book SFO to LAX.',
      userPersona: 'EXPERT',
    });

    expect(scenario.userPersona?.id).toBe('EXPERT');
    expect(scenario.userPersona).toEqual(
      getDefaultPersonaRegistry().getPersona('EXPERT'),
    );
  });

  it('test_user_persona_given_as_unknown_id_raises_not_found', () => {
    const parse = () =>
      conversationScenarioModel.parse({
        startingPrompt: 'hi',
        conversationPlan: 'chat',
        userPersona: 'NO_SUCH_PERSONA',
      });

    expect(parse).toThrow(NotFoundError);
    expect(parse).toThrow('NO_SUCH_PERSONA not found');
  });

  it('test_user_persona_given_as_object_is_kept_verbatim', () => {
    const persona = customPersona();

    const scenario = conversationScenarioModel.parse({
      startingPrompt: 'hi',
      conversationPlan: 'chat',
      userPersona: persona,
    });

    expect(scenario.userPersona).toEqual(persona);
  });

  it('test_user_persona_defaults_to_none', () => {
    const scenario = conversationScenarioModel.parse({
      startingPrompt: 'hi',
      conversationPlan: 'chat',
    });

    expect(scenario.userPersona).toBeUndefined();
    expect('userPersona' in scenario).toBe(false);
  });

  it('test_conversation_scenario_rejects_unknown_field', () => {
    const parse = () =>
      conversationScenarioModel.parse({
        startingPrompt: 'I need to book a flight.',
        conversationPlan: 'Book SFO to LAX.',
        userPersonaa: 'EXPERT',
      });

    expect(parse).toThrow(InputValidationError);
    expect(parse).toThrow('userPersonaa');
  });
});

describe('ConversationScenarios', () => {
  it('test_conversation_scenarios_defaults_to_empty_list', () => {
    expect(conversationScenariosModel.parse({})).toEqual({scenarios: []});
  });

  it('test_conversation_scenarios_round_trips_through_json', () => {
    const scenarios: ConversationScenarios = conversationScenariosModel.parse({
      scenarios: [
        {
          startingPrompt: 'I need to book a flight.',
          conversationPlan: 'Book SFO to LAX, then rent a car.',
          userPersona: 'NOVICE',
        },
        {
          startingPrompt: 'What can you do?',
          conversationPlan: 'Ask about capabilities and stop.',
        },
      ],
    });

    for (const dumped of [
      {...scenarios},
      conversationScenariosModel.dumpByAlias(scenarios),
    ]) {
      const restored = conversationScenariosModel.parse(
        JSON.parse(JSON.stringify(dumped)),
      );

      expect(restored).toEqual(scenarios);
      expect(restored.scenarios[0].userPersona?.id).toBe('NOVICE');
      expect(restored.scenarios[1].userPersona).toBeUndefined();
    }
  });

  it('test_conversation_scenarios_parses_camel_case_json', () => {
    const camelCase = conversationScenariosModel.parse({
      scenarios: [
        {
          startingPrompt: 'I need to book a flight.',
          conversationPlan: 'Book SFO to LAX.',
          userPersona: 'EVALUATOR',
        },
      ],
    });

    const scenario = camelCase.scenarios[0];
    expect(scenario.startingPrompt).toBe('I need to book a flight.');
    expect(scenario.conversationPlan).toBe('Book SFO to LAX.');
    expect(scenario.userPersona?.id).toBe('EVALUATOR');

    // adk-python writes the snake_case spelling, so the same document in that
    // spelling must give the same value.
    const snakeCase = conversationScenariosModel.parse({
      scenarios: [
        {
          starting_prompt: 'I need to book a flight.',
          conversation_plan: 'Book SFO to LAX.',
          user_persona: 'EVALUATOR',
        },
      ],
    });

    expect(snakeCase).toEqual(camelCase);
  });
});
