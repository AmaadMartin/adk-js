/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Ported from google/adk-python
 * `tests/unittests/tools/test_tool_confirmation.py`, branch `main`.
 *
 * Every `it()` keeps the Python test name verbatim, so a reviewer can grep one
 * file against the other.
 */

import {InputValidationError, ToolConfirmation} from '@google/adk';
import {describe, expect, it} from 'vitest';

describe('ToolConfirmation (adk-python parity)', () => {
  // Python asserts on `ToolConfirmation()`. The TypeScript constructor requires
  // `confirmed`, so the no-argument case is the one `fromResponseDict` builds.
  it('test_default_values_are_empty', () => {
    const confirmation = ToolConfirmation.fromResponseDict({});

    expect(confirmation.hint).toBe('');
    expect(confirmation.confirmed).toBe(false);
    expect(confirmation.payload).toBeUndefined();
  });

  it('test_initialization_retains_provided_values', () => {
    const confirmation = new ToolConfirmation({
      hint: 'please confirm',
      confirmed: true,
      payload: {amount: 10},
    });

    expect(confirmation.hint).toBe('please confirm');
    expect(confirmation.confirmed).toBe(true);
    expect(confirmation.payload).toEqual({amount: 10});
  });

  it.each([[[1, 2, 3]], ['raw']])(
    'test_payload_accepts_json_serializable_values [%#]',
    (payloadValue: unknown) => {
      const confirmation = new ToolConfirmation({
        confirmed: false,
        payload: payloadValue,
      });

      expect(confirmation.payload).toBe(payloadValue);
    },
  );

  it.each([[(x: unknown) => x], [{}]])(
    'test_payload_accepts_non_json_serializable_values [%#]',
    (payloadValue: unknown) => {
      const confirmation = new ToolConfirmation({
        confirmed: false,
        payload: payloadValue,
      });

      expect(confirmation.payload).toBe(payloadValue);
    },
  );

  // Python forbids the extra field at construction. TypeScript refuses it at
  // compile time, so the runtime check lives on `fromResponseDict`, which is
  // where untyped input enters.
  it('test_initialization_fails_with_extra_fields', () => {
    expect(() =>
      ToolConfirmation.fromResponseDict({unexpected: 'value'}),
    ).toThrow(InputValidationError);
  });

  it('test_serialization_round_trip_preserves_equality', () => {
    const original = new ToolConfirmation({
      hint: 'confirm transfer',
      confirmed: true,
      payload: {to: 'bob'},
    });

    const dumped = JSON.parse(JSON.stringify(original)) as Record<
      string,
      unknown
    >;
    const validated = ToolConfirmation.fromResponseDict(dumped);

    expect(validated).toEqual(original);
  });
});

describe('ToolConfirmation.fromResponseDict (adk-python parity)', () => {
  it('test_plain_dict_is_validated_directly', () => {
    const confirmation = ToolConfirmation.fromResponseDict({
      hint: 'confirm transfer',
      confirmed: true,
      payload: {to: 'b'},
    });

    expect(confirmation.hint).toBe('confirm transfer');
    expect(confirmation.confirmed).toBe(true);
    expect(confirmation.payload).toEqual({to: 'b'});
  });

  it('test_single_response_key_is_unwrapped_and_json_decoded', () => {
    const confirmation = ToolConfirmation.fromResponseDict({
      response: JSON.stringify({hint: 'h', confirmed: true}),
    });

    expect(confirmation.hint).toBe('h');
    expect(confirmation.confirmed).toBe(true);
  });

  it('test_response_key_alongside_other_keys_is_not_unwrapped', () => {
    expect(() =>
      ToolConfirmation.fromResponseDict({
        response: JSON.stringify({confirmed: true}),
        hint: 'h',
      }),
    ).toThrow(InputValidationError);
  });

  it('test_empty_dict_yields_defaults', () => {
    const confirmation = ToolConfirmation.fromResponseDict({});

    expect(confirmation.hint).toBe('');
    expect(confirmation.confirmed).toBe(false);
    expect(confirmation.payload).toBeUndefined();
  });

  // Python lets the `json.JSONDecodeError` out; adk-js wraps it as an
  // `InputValidationError` that keeps the `SyntaxError` as its `cause`.
  it('test_malformed_wrapper_json_is_not_swallowed', () => {
    expect(() =>
      ToolConfirmation.fromResponseDict({response: 'not json'}),
    ).toThrow(InputValidationError);
  });
});
