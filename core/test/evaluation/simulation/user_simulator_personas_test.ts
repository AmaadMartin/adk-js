/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Ports `tests/unittests/evaluation/simulation/test_user_simulator_personas.py`
 * from google/adk-python at commit e37a8befd0f0. Each `it` keeps the name of
 * the Python test it ports.
 *
 * The two creation tests assert pydantic field assignment in Python. A
 * TypeScript interface is erased at runtime, so they become object-literal
 * construction plus field assertions. They stay because they pin the
 * camelCase field names.
 */

import {
  NotFoundError,
  UserPersonaRegistry,
  getBehaviorInstructionsStr,
  getViolationRubricsStr,
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

    expect(getBehaviorInstructionsStr(behavior)).toBe(
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

    expect(getViolationRubricsStr(behavior)).toBe(
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
  it('test_register_and_get_persona', () => {
    const registry = new UserPersonaRegistry();
    const persona: UserPersona = {
      id: 'test_persona',
      description: 'Test persona',
      behaviors: [],
    };

    registry.registerPersona('persona1', persona);

    expect(registry.getPersona('persona1')).toBe(persona);
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
    const persona1: UserPersona = {
      id: 'test_persona1',
      description: 'Test persona 1',
      behaviors: [],
    };
    const persona2: UserPersona = {
      id: 'test_persona2',
      description: 'Test persona 2',
      behaviors: [],
    };

    registry.registerPersona('persona1', persona1);
    expect(registry.getPersona('persona1')).toBe(persona1);

    registry.registerPersona('persona1', persona2);
    expect(registry.getPersona('persona1')).toBe(persona2);
  });

  it('test_get_registered_personas', () => {
    const registry = new UserPersonaRegistry();
    const persona1: UserPersona = {
      id: 'test_persona1',
      description: 'Test persona 1',
      behaviors: [],
    };
    const persona2: UserPersona = {
      id: 'test_persona2',
      description: 'Test persona 2',
      behaviors: [],
    };

    registry.registerPersona('persona1', persona1);
    registry.registerPersona('persona2', persona2);

    const registeredPersonas = registry.getRegisteredPersonas();
    expect(registeredPersonas).toHaveLength(2);
    expect(registeredPersonas).toContain(persona1);
    expect(registeredPersonas).toContain(persona2);
  });
});
