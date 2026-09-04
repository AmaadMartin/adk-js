/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Ported from adk-python
 * `tests/unittests/evaluation/simulation/test_user_simulator_personas.py`, at
 * commit c7ffcfa85a8e8970f6318306479d9c4c110583b2. Each `it()` keeps the
 * Python test name so the two suites stay greppable against each other.
 */

import {
  behaviorInstructionsToString,
  NotFoundError,
  UserPersonaRegistry,
  violationRubricsToString,
  type UserBehavior,
  type UserPersona,
} from '@google/adk';
import {describe, expect, it} from 'vitest';

describe('UserBehavior', () => {
  it('test_create_user_behavior', () => {
    const behavior: UserBehavior = {
      name: 'test_behavior',
      description: 'Test behavior description.',
      behaviorInstructions: ['instruction1', 'instruction2'],
      violationRubrics: ['violation1', 'violation2'],
    };

    expect(behavior.name).toBe('test_behavior');
    expect(behavior.description).toBe('Test behavior description.');
    expect(behavior.behaviorInstructions).toEqual([
      'instruction1',
      'instruction2',
    ]);
    expect(behavior.violationRubrics).toEqual(['violation1', 'violation2']);
  });

  it('test_get_behavior_instructions_str', () => {
    const behavior: UserBehavior = {
      name: 'test_behavior',
      description: 'Test behavior description.',
      behaviorInstructions: ['instruction1', 'instruction2'],
      violationRubrics: [],
    };

    expect(behaviorInstructionsToString(behavior)).toBe(
      '  * instruction1\n  * instruction2',
    );
  });

  it('test_get_violation_rubrics_str', () => {
    const behavior: UserBehavior = {
      name: 'test_behavior',
      description: 'Test behavior description.',
      behaviorInstructions: [],
      violationRubrics: ['violation1', 'violation2'],
    };

    expect(violationRubricsToString(behavior)).toBe(
      '  * violation1\n  * violation2',
    );
  });
});

describe('UserPersona', () => {
  it('test_create_user_persona', () => {
    const behavior: UserBehavior = {
      name: 'test_behavior',
      description: 'Test behavior description.',
      behaviorInstructions: ['instruction1'],
      violationRubrics: ['violation1'],
    };

    const persona: UserPersona = {
      id: 'test_persona',
      description: 'Test persona description.',
      behaviors: [behavior],
    };

    expect(persona.id).toBe('test_persona');
    expect(persona.description).toBe('Test persona description.');
    expect(persona.behaviors).toEqual([behavior]);
  });
});

describe('UserPersonaRegistry', () => {
  const persona = (id: string, description: string): UserPersona => ({
    id,
    description,
    behaviors: [],
  });

  it('test_register_and_get_persona', () => {
    const registry = new UserPersonaRegistry();
    const testPersona = persona('test_persona', 'Test persona');

    registry.registerPersona('persona1', testPersona);

    expect(registry.getPersona('persona1')).toEqual(testPersona);
  });

  it('test_get_persona_not_found', () => {
    const registry = new UserPersonaRegistry();

    expect(() => registry.getPersona('persona2')).toThrow(NotFoundError);
    expect(() => registry.getPersona('persona2')).toThrow(
      'persona2 not found in registry.',
    );
  });

  it('test_update_persona', () => {
    const registry = new UserPersonaRegistry();
    const persona1 = persona('test_persona1', 'Test persona 1');
    const persona2 = persona('test_persona2', 'Test persona 2');

    registry.registerPersona('persona1', persona1);
    expect(registry.getPersona('persona1')).toEqual(persona1);

    registry.registerPersona('persona1', persona2);
    expect(registry.getPersona('persona1')).toEqual(persona2);
  });

  it('test_get_registered_personas', () => {
    const registry = new UserPersonaRegistry();
    const persona1 = persona('test_persona1', 'Test persona 1');
    const persona2 = persona('test_persona2', 'Test persona 2');

    registry.registerPersona('persona1', persona1);
    registry.registerPersona('persona2', persona2);

    expect(registry.getRegisteredPersonas()).toEqual([persona1, persona2]);
  });
});
