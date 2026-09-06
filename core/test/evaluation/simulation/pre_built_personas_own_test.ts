/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  NotFoundError,
  PRE_BUILT_BEHAVIORS,
  UserBehavior,
  getDefaultPersonaRegistry,
} from '@google/adk';
import {describe, expect, it} from 'vitest';

const EXPECTED_PERSONA_IDS = ['EXPERT', 'NOVICE', 'EVALUATOR'];
const BEHAVIOR_ENTRIES: Array<[string, UserBehavior]> =
  Object.entries(PRE_BUILT_BEHAVIORS);
const BEHAVIOR_KEY_BY_BEHAVIOR = new Map<UserBehavior, string>(
  BEHAVIOR_ENTRIES.map(([key, behavior]) => [behavior, key]),
);

/** Names the behaviors a shipped persona is composed from, in order. */
function behaviorKeysOf(personaId: string): Array<string | undefined> {
  return getDefaultPersonaRegistry()
    .getPersona(personaId)
    .behaviors.map((behavior) => BEHAVIOR_KEY_BY_BEHAVIOR.get(behavior));
}

describe('getDefaultPersonaRegistry', () => {
  it('returns a distinct registry on every call', () => {
    expect(getDefaultPersonaRegistry()).not.toBe(getDefaultPersonaRegistry());
  });

  it('does not leak a persona registered into one registry into a later one', () => {
    const registry = getDefaultPersonaRegistry();
    registry.registerPersona('IMPATIENT', {
      id: 'IMPATIENT',
      description: 'Wants the task done in as few turns as possible.',
      behaviors: [PRE_BUILT_BEHAVIORS.END_NO_TROUBLESHOOTING],
    });

    expect(() => getDefaultPersonaRegistry().getPersona('IMPATIENT')).toThrow(
      NotFoundError,
    );
  });

  it('does not leak a shipped persona replaced in one registry into a later one', () => {
    const replacement = {
      id: 'EXPERT',
      description: 'A replacement persona.',
      behaviors: [],
    };
    const registry = getDefaultPersonaRegistry();

    registry.registerPersona('EXPERT', replacement);

    expect(registry.getPersona('EXPERT')).toEqual(replacement);
    expect(getDefaultPersonaRegistry().getPersona('EXPERT')).not.toEqual(
      replacement,
    );
  });

  it('holds exactly the three shipped personas, in order', () => {
    const personas = getDefaultPersonaRegistry().getRegisteredPersonas();

    expect(personas.map((persona) => persona.id)).toEqual(EXPECTED_PERSONA_IDS);
  });

  it('registers each persona under its own id', () => {
    const registry = getDefaultPersonaRegistry();

    for (const personaId of EXPECTED_PERSONA_IDS) {
      expect(registry.getPersona(personaId).id).toBe(personaId);
    }
  });

  it('throws NotFoundError for an id it does not hold', () => {
    expect(() =>
      getDefaultPersonaRegistry().getPersona('MISSING'),
    ).toThrowError(new NotFoundError('MISSING not found in registry.'));
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
});

describe('PRE_BUILT_BEHAVIORS', () => {
  it('holds the eleven reference behaviors in reference order', () => {
    expect(BEHAVIOR_ENTRIES.map(([key]) => key)).toEqual([
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

  it.each(BEHAVIOR_ENTRIES)('names and describes %s', (_key, behavior) => {
    expect(behavior.name.trim()).not.toBe('');
    expect(behavior.description.trim()).not.toBe('');
  });

  it('is frozen', () => {
    expect(Object.isFrozen(PRE_BUILT_BEHAVIORS)).toBe(true);
  });

  it('gives the two ending behaviors the same name on purpose', () => {
    expect(PRE_BUILT_BEHAVIORS.END_NO_TROUBLESHOOTING.name).toBe(
      PRE_BUILT_BEHAVIORS.END_LIMITED_TROUBLESHOOTING.name,
    );
    expect(PRE_BUILT_BEHAVIORS.END_NO_TROUBLESHOOTING.description).not.toBe(
      PRE_BUILT_BEHAVIORS.END_LIMITED_TROUBLESHOOTING.description,
    );
  });

  it('keeps the stop signal placeholder as literal text', () => {
    expect(
      PRE_BUILT_BEHAVIORS.DO_NOT_CORRECT_AGENT.behaviorInstructions[0],
    ).toBe(
      'If the Agent made an illogical or incorrect statement, end the conversation with `{{ stop_signal }}`.',
    );
  });

  it('shares one behavior object between the personas that use it', () => {
    const registry = getDefaultPersonaRegistry();

    expect(registry.getPersona('EXPERT').behaviors[0]).toBe(
      registry.getPersona('EVALUATOR').behaviors[0],
    );
    expect(registry.getPersona('EXPERT').behaviors[0]).toBe(
      PRE_BUILT_BEHAVIORS.ADVANCE_DETAIL_ORIENTED,
    );
  });
});
