/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Ported from adk-python
 * `tests/unittests/evaluation/simulation/test_pre_built_personas.py`
 * at commit a3bd11152db6562054db1c509ec44509436d99e7.
 */

import {
  PRE_BUILT_BEHAVIORS,
  UserBehavior,
  getBehaviorInstructionsStr,
  getDefaultPersonaRegistry,
  getViolationRubricsStr,
} from '@google/adk';
import {describe, expect, it} from 'vitest';

const BEHAVIOR_ENTRIES = Object.entries(PRE_BUILT_BEHAVIORS);

describe('pre-built personas', () => {
  it('test_get_default_persona_registry', () => {
    expect(getDefaultPersonaRegistry()).toBeDefined();
  });

  // Both strings are interpolated into the user-simulator instructions and
  // into the verifier rubrics, so an empty list here silently produces an
  // empty prompt section rather than a visible failure.
  it.each(BEHAVIOR_ENTRIES)(
    'test_pre_built_behavior_renders_instructions_and_rubrics: %s',
    (_name, behavior: UserBehavior) => {
      expect(getBehaviorInstructionsStr(behavior).trim()).not.toBe('');
      expect(getViolationRubricsStr(behavior).trim()).not.toBe('');
    },
  );

  // Python asserts `len(list(PreBuiltBehaviors)) == len(__members__)`, which
  // detects two behaviors with identical contents collapsing into one enum
  // alias. An object literal has no such collapse, so the assertion is adapted
  // to compare the entries directly; the invariant it guards is the same.
  it('test_pre_built_behaviors_have_no_enum_aliases', () => {
    for (const [nameA, behaviorA] of BEHAVIOR_ENTRIES) {
      for (const [nameB, behaviorB] of BEHAVIOR_ENTRIES) {
        if (nameA !== nameB) {
          expect(behaviorA, `${nameA} duplicates ${nameB}`).not.toEqual(
            behaviorB,
          );
        }
      }
    }
  });

  it.each(['EXPERT', 'NOVICE', 'EVALUATOR'])(
    'test_default_personas_compose_distinct_pre_built_behaviors: %s',
    (personaId) => {
      const persona = getDefaultPersonaRegistry().getPersona(personaId);
      const knownBehaviors = Object.values(PRE_BUILT_BEHAVIORS);

      expect(persona.behaviors, `${personaId} has no behaviors`).not.toEqual(
        [],
      );
      for (const behavior of persona.behaviors) {
        expect(
          knownBehaviors,
          `${personaId} uses a behavior that is not in PRE_BUILT_BEHAVIORS: ${behavior.name}`,
        ).toContainEqual(behavior);
      }
      const behaviorNames = persona.behaviors.map((b) => b.name);
      expect(
        new Set(behaviorNames).size,
        `${personaId} lists a behavior more than once: ${behaviorNames.join(', ')}`,
      ).toBe(behaviorNames.length);
    },
  );
});
