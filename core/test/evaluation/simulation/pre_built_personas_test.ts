/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  getDefaultPersonaRegistry,
  PRE_BUILT_BEHAVIORS,
  PRE_BUILT_PERSONAS,
  UserPersonaRegistry,
} from '@google/adk';
import {describe, expect, it} from 'vitest';

describe('getDefaultPersonaRegistry', () => {
  it('returns a registry', () => {
    const registry = getDefaultPersonaRegistry();
    expect(registry).toBeInstanceOf(UserPersonaRegistry);
  });

  it('registers the three default personas, each resolvable by id', () => {
    const registry = getDefaultPersonaRegistry();
    for (const id of ['EXPERT', 'NOVICE', 'EVALUATOR']) {
      const persona = registry.getPersona(id);
      expect(persona.id).toBe(id);
    }
    expect(registry.getRegisteredPersonas()).toHaveLength(3);
  });

  it('composes each default persona with the expected behaviors', () => {
    const registry = getDefaultPersonaRegistry();
    expect(registry.getPersona('EXPERT').behaviors).toHaveLength(6);
    expect(registry.getPersona('NOVICE').behaviors).toHaveLength(5);
    expect(registry.getPersona('EVALUATOR').behaviors).toHaveLength(5);
  });

  it('returns an independent registry on each call', () => {
    const first = getDefaultPersonaRegistry();
    const second = getDefaultPersonaRegistry();
    expect(first).not.toBe(second);
  });
});

describe('pre-built persona data', () => {
  it('exposes the atomic behaviors and personas as consts', () => {
    expect(Object.keys(PRE_BUILT_BEHAVIORS)).toHaveLength(11);
    expect(PRE_BUILT_PERSONAS.EXPERT.behaviors[0]).toBe(
      PRE_BUILT_BEHAVIORS.ADVANCE_DETAIL_ORIENTED,
    );
  });
});
