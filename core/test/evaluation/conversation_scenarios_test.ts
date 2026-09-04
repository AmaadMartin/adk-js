/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Ported from adk-python `main`:
 * `tests/unittests/evaluation/test_conversation_scenarios.py`.
 * Each `it()` keeps the reference test name.
 */

import {
  conversationScenariosModel,
  getDefaultPersonaRegistry,
  isInputValidationError,
  NotFoundError,
  parseConversationScenario,
  parseConversationScenarios,
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
    const scenario = parseConversationScenario({
      startingPrompt: 'I need to book a flight.',
      conversationPlan: 'Book SFO to LAX.',
      userPersona: 'EXPERT',
    });

    const expected = getDefaultPersonaRegistry().getPersona('EXPERT');
    expect(scenario.userPersona?.id).toBe('EXPERT');
    expect(scenario.userPersona).toEqual(expected);
  });

  it('test_user_persona_given_as_unknown_id_raises_not_found', () => {
    expect(() =>
      parseConversationScenario({
        startingPrompt: 'hi',
        conversationPlan: 'chat',
        userPersona: 'NO_SUCH_PERSONA',
      }),
    ).toThrowError(
      expect.objectContaining({
        name: 'NotFoundError',
        message: expect.stringContaining('NO_SUCH_PERSONA not found'),
      }),
    );
  });

  it('test_user_persona_given_as_object_is_kept_verbatim', () => {
    const persona = customPersona();

    const scenario = parseConversationScenario({
      startingPrompt: 'hi',
      conversationPlan: 'chat',
      userPersona: persona,
    });

    expect(scenario.userPersona).toEqual(persona);
  });

  it('test_user_persona_defaults_to_none', () => {
    const scenario = parseConversationScenario({
      startingPrompt: 'hi',
      conversationPlan: 'chat',
    });

    expect(scenario.userPersona).toBeUndefined();
  });

  it('test_conversation_scenario_rejects_unknown_field', () => {
    let caught: unknown;
    try {
      parseConversationScenario({
        startingPrompt: 'I need to book a flight.',
        conversationPlan: 'Book SFO to LAX.',
        userPersonaa: 'EXPERT',
      });
    } catch (error: unknown) {
      caught = error;
    }

    if (!isInputValidationError(caught)) {
      expect.fail(`expected an InputValidationError, got ${String(caught)}`);
    }
    expect(caught.message).toContain('userPersonaa');
    expect(caught.message).toContain('Unrecognized key');
  });
});

describe('ConversationScenarios', () => {
  it('test_conversation_scenarios_defaults_to_empty_list', () => {
    expect(parseConversationScenarios({}).scenarios).toEqual([]);
  });

  it('test_conversation_scenarios_round_trips_through_json', () => {
    const scenarios = parseConversationScenarios({
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

    const restored = parseConversationScenarios(
      JSON.parse(JSON.stringify(conversationScenariosModel.dump(scenarios))),
    );

    expect(restored).toEqual(scenarios);
    expect(restored.scenarios[0].userPersona?.id).toBe('NOVICE');
    expect(restored.scenarios[1].userPersona).toBeUndefined();
  });

  it('test_conversation_scenarios_parses_camel_case_json', () => {
    const scenarios = parseConversationScenarios({
      scenarios: [
        {
          startingPrompt: 'I need to book a flight.',
          conversationPlan: 'Book SFO to LAX.',
          userPersona: 'EVALUATOR',
        },
      ],
    });

    const scenario = scenarios.scenarios[0];
    expect(scenario.startingPrompt).toBe('I need to book a flight.');
    expect(scenario.conversationPlan).toBe('Book SFO to LAX.');
    expect(scenario.userPersona?.id).toBe('EVALUATOR');
  });
});

describe('NotFoundError propagation', () => {
  it('surfaces the registry error unwrapped from a nested scenario', () => {
    expect(() =>
      parseConversationScenarios({
        scenarios: [
          {
            startingPrompt: 'hi',
            conversationPlan: 'chat',
            userPersona: 'NOPE',
          },
        ],
      }),
    ).toThrowError(NotFoundError);
  });
});
