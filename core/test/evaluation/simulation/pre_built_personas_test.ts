/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Ported from adk-python
 * `tests/unittests/evaluation/simulation/test_pre_built_personas.py`, at commit
 * c7ffcfa85a8e8970f6318306479d9c4c110583b2. Each `it()` keeps the Python test
 * name so the two suites stay greppable against each other.
 */

import {
  behaviorInstructionsToString,
  getDefaultPersonaRegistry,
  PRE_BUILT_BEHAVIORS,
  violationRubricsToString,
  type UserBehavior,
} from '@google/adk';
import {describe, expect, it} from 'vitest';

const behaviorEntries: Array<[string, UserBehavior]> =
  Object.entries(PRE_BUILT_BEHAVIORS);

describe('pre-built personas', () => {
  it('test_get_default_persona_registry', () => {
    expect(getDefaultPersonaRegistry()).toBeDefined();
  });

  it.each(behaviorEntries)(
    'test_pre_built_behavior_renders_instructions_and_rubrics: %s',
    (_name, behavior) => {
      expect(behaviorInstructionsToString(behavior).trim()).not.toBe('');
      expect(violationRubricsToString(behavior).trim()).not.toBe('');
    },
  );

  it('test_pre_built_behaviors_have_no_enum_aliases', () => {
    // adk-python declares these as an `enum`, where two members with equal
    // values collapse into one: the alias keeps its name but drops out of
    // iteration, and a persona naming it silently gets the other behavior.
    // TypeScript object keys cannot collapse, so this asserts the intent the
    // Python test protects: no two behaviors hold the same content.
    const contents = behaviorEntries.map(([, behavior]) =>
      JSON.stringify(behavior),
    );

    expect(new Set(contents).size).toBe(behaviorEntries.length);
  });

  it.each(['EXPERT', 'NOVICE', 'EVALUATOR'])(
    'test_default_personas_compose_distinct_pre_built_behaviors: %s',
    (personaId) => {
      const persona = getDefaultPersonaRegistry().getPersona(personaId);
      const knownBehaviors = behaviorEntries.map(([, behavior]) => behavior);

      expect(persona.behaviors.length).toBeGreaterThan(0);
      for (const behavior of persona.behaviors) {
        expect(knownBehaviors).toContain(behavior);
      }

      const behaviorNames = persona.behaviors.map((behavior) => behavior.name);
      expect(new Set(behaviorNames).size).toBe(behaviorNames.length);
    },
  );
});
