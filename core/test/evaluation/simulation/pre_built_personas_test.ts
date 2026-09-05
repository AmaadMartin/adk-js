/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Ported from adk-python `main`:
 * `tests/unittests/evaluation/simulation/test_pre_built_personas.py`.
 * Each `it()` keeps the reference test name.
 */

import {
  behaviorInstructionsText,
  getDefaultPersonaRegistry,
  PRE_BUILT_BEHAVIORS,
  violationRubricsText,
} from '@google/adk';
import {describe, expect, it} from 'vitest';

const BEHAVIORS = Object.entries(PRE_BUILT_BEHAVIORS);
const DEFAULT_PERSONA_IDS = ['EXPERT', 'NOVICE', 'EVALUATOR'];

describe('pre-built personas', () => {
  it('test_get_default_persona_registry', () => {
    expect(getDefaultPersonaRegistry()).toBeDefined();
  });

  it.each(BEHAVIORS)(
    'test_pre_built_behavior_renders_instructions_and_rubrics: %s',
    (_name, behavior) => {
      expect(behaviorInstructionsText(behavior).trim()).not.toBe('');
      expect(violationRubricsText(behavior).trim()).not.toBe('');
    },
  );

  it.each(DEFAULT_PERSONA_IDS)(
    'test_default_personas_compose_distinct_pre_built_behaviors: %s',
    (personaId) => {
      const persona = getDefaultPersonaRegistry().getPersona(personaId);
      const known = Object.values(PRE_BUILT_BEHAVIORS);

      expect(persona.behaviors).not.toHaveLength(0);
      for (const behavior of persona.behaviors) {
        expect(known).toContain(behavior);
      }
      const names = persona.behaviors.map((behavior) => behavior.name);
      expect(new Set(names).size).toBe(names.length);
    },
  );
});
