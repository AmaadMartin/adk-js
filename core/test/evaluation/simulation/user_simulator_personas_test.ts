/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  getBehaviorInstructionsStr,
  getViolationRubricsStr,
  NotFoundError,
  UserBehavior,
  UserPersona,
  UserPersonaRegistry,
} from '@google/adk';
import {describe, expect, it} from 'vitest';

describe('UserBehavior', () => {
  it('creates a user behavior', () => {
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

  it('renders behavior instructions as a string', () => {
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

  it('renders violation rubrics as a string', () => {
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
  it('creates a user persona', () => {
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
  const makePersona = (id: string, description: string): UserPersona => ({
    id,
    description,
    behaviors: [],
  });

  it('registers and gets a persona', () => {
    const registry = new UserPersonaRegistry();
    const persona = makePersona('test_persona', 'Test persona');
    registry.registerPersona('persona1', persona);
    expect(registry.getPersona('persona1')).toBe(persona);
  });

  it('throws NotFoundError for an unknown persona', () => {
    const registry = new UserPersonaRegistry();
    expect(() => registry.getPersona('persona2')).toThrow(NotFoundError);
    expect(() => registry.getPersona('persona2')).toThrow(
      'persona2 not found in registry.',
    );
  });

  it('updates an existing persona', () => {
    const registry = new UserPersonaRegistry();
    const persona1 = makePersona('test_persona1', 'Test persona 1');
    const persona2 = makePersona('test_persona2', 'Test persona 2');
    registry.registerPersona('persona1', persona1);
    expect(registry.getPersona('persona1')).toBe(persona1);
    registry.registerPersona('persona1', persona2);
    expect(registry.getPersona('persona1')).toBe(persona2);
  });

  it('lists the registered personas', () => {
    const registry = new UserPersonaRegistry();
    const persona1 = makePersona('test_persona1', 'Test persona 1');
    const persona2 = makePersona('test_persona2', 'Test persona 2');
    registry.registerPersona('persona1', persona1);
    registry.registerPersona('persona2', persona2);
    const registered = registry.getRegisteredPersonas();
    expect(registered).toHaveLength(2);
    expect(registered).toContain(persona1);
    expect(registered).toContain(persona2);
  });
});
