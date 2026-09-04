/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Ported from adk-python
 * `tests/unittests/evaluation/simulation/test_pre_built_personas.py`
 * at ref a3bd1115. The test names are kept verbatim so a reader can find the
 * original.
 */

import {
  PRE_BUILT_BEHAVIORS,
  UserBehavior,
  getBehaviorInstructionsStr,
  getDefaultPersonaRegistry,
  getViolationRubricsStr,
} from '@google/adk';
import {describe, expect, it} from 'vitest';

const BEHAVIOR_ENTRIES: Array<[string, UserBehavior]> =
  Object.entries(PRE_BUILT_BEHAVIORS);

describe('pre-built personas', () => {
  it('test_get_default_persona_registry', () => {
    expect(getDefaultPersonaRegistry()).toBeDefined();
  });

  it.each(BEHAVIOR_ENTRIES)(
    'test_pre_built_behavior_renders_instructions_and_rubrics: %s',
    (_key, behavior) => {
      // Both strings are interpolated into the user simulator instructions and
      // into the verifier rubrics, so an empty list here silently produces an
      // empty prompt section rather than a visible failure.
      expect(getBehaviorInstructionsStr(behavior).trim()).not.toBe('');
      expect(getViolationRubricsStr(behavior).trim()).not.toBe('');
    },
  );

  it('test_pre_built_behaviors_have_no_enum_aliases', () => {
    // Python collapses two enum members with equal values into an alias, so a
    // duplicated behavior disappears from iteration. A frozen record cannot do
    // that, so the intent is asserted directly: every entry is distinct by
    // content.
    const serialized = BEHAVIOR_ENTRIES.map(([, behavior]) =>
      JSON.stringify(behavior),
    );

    expect(new Set(serialized).size).toBe(serialized.length);
  });

  it.each(['EXPERT', 'NOVICE', 'EVALUATOR'])(
    'test_default_personas_compose_distinct_pre_built_behaviors: %s',
    (personaId) => {
      const persona = getDefaultPersonaRegistry().getPersona(personaId);
      const knownBehaviors: UserBehavior[] = Object.values(PRE_BUILT_BEHAVIORS);

      expect(persona.behaviors.length).toBeGreaterThan(0);
      for (const behavior of persona.behaviors) {
        expect(knownBehaviors).toContain(behavior);
      }
      expect(new Set(persona.behaviors).size).toBe(persona.behaviors.length);
    },
  );
});
