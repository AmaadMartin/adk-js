/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/** Edge cases of the registry and the renderers the reference tests skip. */

import {
  behaviorInstructionsToString,
  UserPersonaRegistry,
  violationRubricsToString,
  type UserBehavior,
  type UserPersona,
} from '@google/adk';
import {describe, expect, it} from 'vitest';

const emptyBehavior: UserBehavior = {
  name: 'empty',
  description: 'Lists nothing.',
  behaviorInstructions: [],
  violationRubrics: [],
};

const persona = (id: string): UserPersona => ({
  id,
  description: `Persona ${id}.`,
  behaviors: [],
});

describe('behavior renderers', () => {
  it('render an empty list as an empty string', () => {
    expect(behaviorInstructionsToString(emptyBehavior)).toBe('');
    expect(violationRubricsToString(emptyBehavior)).toBe('');
  });

  it('render a single item without a trailing newline', () => {
    const behavior: UserBehavior = {
      ...emptyBehavior,
      behaviorInstructions: ['only'],
      violationRubrics: ['only'],
    };

    expect(behaviorInstructionsToString(behavior)).toBe('  * only');
    expect(violationRubricsToString(behavior)).toBe('  * only');
  });
});

describe('UserPersonaRegistry', () => {
  it('holds nothing before anything is registered', () => {
    expect(new UserPersonaRegistry().getRegisteredPersonas()).toEqual([]);
  });

  it('keeps registration order when an id is replaced', () => {
    const registry = new UserPersonaRegistry();
    registry.registerPersona('first', persona('first'));
    registry.registerPersona('second', persona('second'));

    registry.registerPersona('first', persona('replacement'));

    expect(registry.getRegisteredPersonas().map((entry) => entry.id)).toEqual([
      'replacement',
      'second',
    ]);
  });

  it('registers a persona under an id that differs from its own', () => {
    const registry = new UserPersonaRegistry();
    const expert = persona('EXPERT');

    registry.registerPersona('alias', expert);

    expect(registry.getPersona('alias')).toBe(expert);
    expect(() => registry.getPersona('EXPERT')).toThrow(
      'EXPERT not found in registry.',
    );
  });
});
