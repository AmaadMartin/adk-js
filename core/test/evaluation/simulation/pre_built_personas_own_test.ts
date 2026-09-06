/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Pins the ported behavior set and the composition of each default persona,
 * which the reference tests only check for membership.
 */

import {
  getDefaultPersonaRegistry,
  NotFoundError,
  PRE_BUILT_BEHAVIORS,
  type UserBehavior,
  type UserPersona,
} from '@google/adk';
import {describe, expect, it} from 'vitest';

const behaviorKeyByBehavior = new Map<UserBehavior, string>(
  Object.entries(PRE_BUILT_BEHAVIORS).map(([key, behavior]) => [behavior, key]),
);

function behaviorKeysOf(personaId: string): Array<string | undefined> {
  return getDefaultPersonaRegistry()
    .getPersona(personaId)
    .behaviors.map((behavior) => behaviorKeyByBehavior.get(behavior));
}

describe('PRE_BUILT_BEHAVIORS', () => {
  it('holds the eleven behaviors adk-python declares', () => {
    expect(Object.keys(PRE_BUILT_BEHAVIORS)).toEqual([
      'ADVANCE_DETAIL_ORIENTED',
      'ADVANCE_GOAL_ORIENTED',
      'ANSWER_RELEVANT_ONLY',
      'ANSWER_ALL',
      'CORRECT_AGENT',
      'DO_NOT_CORRECT_AGENT',
      'TROUBLESHOOT_ONCE',
      'END_LIMITED_TROUBLESHOOTING',
      'END_NO_TROUBLESHOOTING',
      'TONE_PROFESSIONAL',
      'TONE_CONVERSATIONAL',
    ]);
  });

  it('is frozen', () => {
    expect(Object.isFrozen(PRE_BUILT_BEHAVIORS)).toBe(true);
  });

  it('keeps the stop signal placeholder the simulator substitutes', () => {
    expect(
      PRE_BUILT_BEHAVIORS.DO_NOT_CORRECT_AGENT.behaviorInstructions[0],
    ).toContain('{{ stop_signal }}');
  });
});

describe('getDefaultPersonaRegistry', () => {
  it('registers the three default personas under their own ids', () => {
    const registered: UserPersona[] =
      getDefaultPersonaRegistry().getRegisteredPersonas();

    expect(registered.map((persona) => persona.id)).toEqual([
      'EXPERT',
      'NOVICE',
      'EVALUATOR',
    ]);
  });

  it('composes each default persona from the adk-python behavior list', () => {
    expect(behaviorKeysOf('EXPERT')).toEqual([
      'ADVANCE_DETAIL_ORIENTED',
      'ANSWER_RELEVANT_ONLY',
      'CORRECT_AGENT',
      'TROUBLESHOOT_ONCE',
      'END_LIMITED_TROUBLESHOOTING',
      'TONE_PROFESSIONAL',
    ]);
    expect(behaviorKeysOf('NOVICE')).toEqual([
      'ADVANCE_GOAL_ORIENTED',
      'DO_NOT_CORRECT_AGENT',
      'ANSWER_ALL',
      'END_NO_TROUBLESHOOTING',
      'TONE_CONVERSATIONAL',
    ]);
    expect(behaviorKeysOf('EVALUATOR')).toEqual([
      'ADVANCE_DETAIL_ORIENTED',
      'ANSWER_RELEVANT_ONLY',
      'END_NO_TROUBLESHOOTING',
      'DO_NOT_CORRECT_AGENT',
      'TONE_CONVERSATIONAL',
    ]);
  });

  it('gives each caller a registry it can change on its own', () => {
    const first = getDefaultPersonaRegistry();
    first.registerPersona('MINE', {
      id: 'MINE',
      description: 'Registered by one caller only.',
      behaviors: [],
    });

    expect(() => getDefaultPersonaRegistry().getPersona('MINE')).toThrow(
      NotFoundError,
    );
    expect(first.getPersona('MINE').id).toBe('MINE');
  });
});
