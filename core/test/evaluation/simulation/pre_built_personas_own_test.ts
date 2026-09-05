/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Cases the adk-python reference tests have no reason to cover, plus the
 * replacement for `test_pre_built_behaviors_have_no_enum_aliases`. That test
 * guards a Python `enum` artifact: two members holding equal values collapse
 * into one alias and disappear from iteration. A TypeScript object literal
 * keeps both keys, so the duplicate itself is what has to be detected.
 */

import {
  getDefaultPersonaRegistry,
  NotFoundError,
  PRE_BUILT_BEHAVIORS,
} from '@google/adk';
import {describe, expect, it} from 'vitest';

describe('PRE_BUILT_BEHAVIORS', () => {
  it('holds no two behaviors with identical contents', () => {
    const definitions = Object.values(PRE_BUILT_BEHAVIORS).map((behavior) =>
      JSON.stringify(behavior),
    );

    expect(new Set(definitions).size).toBe(definitions.length);
  });
});

describe('getDefaultPersonaRegistry', () => {
  it('registers the three built-in personas', () => {
    const ids = getDefaultPersonaRegistry()
      .getRegisteredPersonas()
      .map((persona) => persona.id);

    expect(ids).toEqual(['EXPERT', 'NOVICE', 'EVALUATOR']);
  });

  it('returns an independent registry on every call', () => {
    const replacement = {
      id: 'EXPERT',
      description: 'A replacement persona.',
      behaviors: [],
    };
    const registry = getDefaultPersonaRegistry();

    registry.registerPersona('EXPERT', replacement);
    registry.registerPersona('EXTRA', {...replacement, id: 'EXTRA'});

    expect(registry.getPersona('EXPERT')).toEqual(replacement);
    const next = getDefaultPersonaRegistry();
    expect(next.getPersona('EXPERT')).not.toEqual(replacement);
    expect(() => next.getPersona('EXTRA')).toThrowError(NotFoundError);
  });
});
