/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Type-safe handling of values a model supplied, which may be hallucinated.
 *
 * A model writes a skill name or a file path into a tool call. Nothing has
 * checked that value yet, so it starts out as a `MaybeHallucinated`. The code
 * that resolves the value against real data confirms it, which produces a
 * separate `ConfirmedNotHallucinated` value.
 *
 * `bounded` reduces an unconfirmed value to the literal `<hallucinated>`. Use
 * it wherever an invented value would otherwise grow unbounded cardinality,
 * such as a metric dimension.
 *
 * Ported from `src/google/adk/telemetry/_hallucination.py` in
 * `google/adk-python` at `b0180620f4c2f4f4467a89c37a30f75bf849700b`.
 */

/** What `bounded` reports for a value nothing has confirmed. */
export const HALLUCINATED = '<hallucinated>';

/** A value the model supplied that is not yet confirmed to be valid. */
export interface MaybeHallucinated<T> {
  /** The value as the model wrote it. */
  readonly maybeHallucinatedValue: T;
  /** Whether something resolved this value against real data. */
  readonly confirmed: boolean;
}

/** A value the model supplied that is confirmed to be valid. */
export interface ConfirmedNotHallucinated<T> extends MaybeHallucinated<T> {
  readonly confirmed: true;
}

/** Wraps a value the model supplied, before anything resolves it. */
export function maybeHallucinated<T>(value: T): MaybeHallucinated<T> {
  const unconfirmed: MaybeHallucinated<T> = {
    maybeHallucinatedValue: value,
    confirmed: false,
  };
  return Object.freeze(unconfirmed);
}

/**
 * Wraps a value that resolved against real data.
 *
 * This returns a new value. The value it was derived from keeps its own
 * standing, so confirming one does not confirm the other.
 */
export function confirmedNotHallucinated<T>(
  value: T,
): ConfirmedNotHallucinated<T> {
  const confirmed: ConfirmedNotHallucinated<T> = {
    maybeHallucinatedValue: value,
    confirmed: true,
  };
  return Object.freeze(confirmed);
}

/**
 * Reduces a value to the set of values that are known to be correct.
 *
 * @returns The value itself when it is confirmed, and `<hallucinated>`
 *     otherwise.
 */
export function bounded<T>(
  value: MaybeHallucinated<T>,
): T | typeof HALLUCINATED {
  return value.confirmed ? value.maybeHallucinatedValue : HALLUCINATED;
}
