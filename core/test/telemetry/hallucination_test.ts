/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * What a model-supplied value may become, and where each form is allowed.
 *
 * Ported from `tests/unittests/telemetry/test_hallucination.py` in
 * `google/adk-python` at `b0180620f4c2f4f4467a89c37a30f75bf849700b`. All five
 * reference tests are here and keep their reference names, so the two suites
 * can be compared by name.
 */

import {describe, expect, it} from 'vitest';

import {
  bounded,
  confirmedNotHallucinated,
  HALLUCINATED,
  maybeHallucinated,
} from '../../src/telemetry/_hallucination.js';

describe('hallucination', () => {
  it('test_a_value_is_unconfirmed_until_something_resolves_it', () => {
    const value = maybeHallucinated('some-skill');

    expect(value.maybeHallucinatedValue).toBe('some-skill');
    expect(value.confirmed).toBe(false);
  });

  it('test_a_value_cannot_be_changed_in_place', () => {
    const value = maybeHallucinated('some-skill');

    expect(Object.isFrozen(value)).toBe(true);
    expect(() =>
      Object.assign(value, {maybeHallucinatedValue: 'another-skill'}),
    ).toThrow(TypeError);
    expect(value.maybeHallucinatedValue).toBe('some-skill');
  });

  it('test_confirming_a_value_does_not_confirm_the_one_it_came_from', () => {
    const unconfirmed = maybeHallucinated('some-skill');

    confirmedNotHallucinated(unconfirmed.maybeHallucinatedValue);

    expect(unconfirmed.confirmed).toBe(false);
    expect(bounded(unconfirmed)).toBe(HALLUCINATED);
  });

  it('test_only_a_confirmed_value_reaches_a_metric', () => {
    expect(bounded(confirmedNotHallucinated('some-skill'))).toBe('some-skill');
    expect(bounded(maybeHallucinated('some-skill'))).toBe('<hallucinated>');
  });

  it('test_standing_is_part_of_a_value_s_identity', () => {
    expect(maybeHallucinated('x')).toEqual(maybeHallucinated('x'));
    expect(confirmedNotHallucinated('x')).toEqual(
      confirmedNotHallucinated('x'),
    );
    expect(maybeHallucinated('x')).not.toEqual(confirmedNotHallucinated('x'));
  });
});
