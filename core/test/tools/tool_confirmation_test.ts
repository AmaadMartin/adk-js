/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  InputValidationError,
  IntentMismatchError,
  ToolConfirmation,
  isIntentMismatchError,
} from '@google/adk';
import {describe, expect, it} from 'vitest';

/** Returns the {@link InputValidationError} that `parse` threw. */
function rejection(parse: () => unknown): InputValidationError {
  try {
    parse();
  } catch (e: unknown) {
    if (e instanceof InputValidationError) {
      return e;
    }
    expect.fail(`expected an InputValidationError, got ${String(e)}`);
  }
  expect.fail('expected the call to throw');
}

describe('ToolConfirmation', () => {
  it('stores all provided fields', () => {
    const confirmation = new ToolConfirmation({
      hint: 'Please confirm.',
      confirmed: true,
      payload: {key: 'value'},
    });

    expect(confirmation.hint).toBe('Please confirm.');
    expect(confirmation.confirmed).toBe(true);
    expect(confirmation.payload).toEqual({key: 'value'});
  });

  it('defaults hint to empty string when omitted', () => {
    const confirmation = new ToolConfirmation({confirmed: false});

    expect(confirmation.hint).toBe('');
  });

  it('stores confirmed as false', () => {
    const confirmation = new ToolConfirmation({confirmed: false});

    expect(confirmation.confirmed).toBe(false);
  });

  it('stores confirmed as true', () => {
    const confirmation = new ToolConfirmation({confirmed: true});

    expect(confirmation.confirmed).toBe(true);
  });

  it('leaves payload as undefined when not provided', () => {
    const confirmation = new ToolConfirmation({confirmed: true});

    expect(confirmation.payload).toBeUndefined();
  });

  it('accepts a JSON-serializable payload object', () => {
    const payload = {userId: 123, action: 'delete', tags: ['a', 'b']};
    const confirmation = new ToolConfirmation({
      confirmed: true,
      payload,
    });

    expect(() => JSON.stringify(confirmation.payload)).not.toThrow();
    expect(JSON.parse(JSON.stringify(confirmation.payload))).toEqual(payload);
  });
});

describe('ToolConfirmation.fromResponseDict', () => {
  it('carries a payload through verbatim, snake_case keys and all', () => {
    const payload = {order_id: 7, line_items: [{sku_id: 'a'}]};

    const confirmation = ToolConfirmation.fromResponseDict({
      confirmed: true,
      payload,
    });

    expect(confirmation.payload).toBe(payload);
    expect(confirmation.payload).toEqual({
      order_id: 7,
      line_items: [{sku_id: 'a'}],
    });
  });

  it.each([
    ['a number', 123, 'ToolConfirmation envelope must decode to an object.'],
    [
      'an object',
      {confirmed: true},
      'ToolConfirmation envelope is not valid JSON.',
    ],
    ['null', null, 'ToolConfirmation envelope must decode to an object.'],
  ])(
    'refuses an envelope carrying %s instead of a JSON string',
    (_, value, message) => {
      expect(() =>
        ToolConfirmation.fromResponseDict({response: value}),
      ).toThrow(message);
    },
  );

  it.each([
    ['a string', '"just a string"'],
    ['an array', '[1,2]'],
    ['null', 'null'],
  ])('refuses an envelope whose JSON decodes to %s', (_, json) => {
    expect(() => ToolConfirmation.fromResponseDict({response: json})).toThrow(
      'ToolConfirmation envelope must decode to an object.',
    );
  });

  it('refuses a string `confirmed` rather than reading it as approval', () => {
    const error = rejection(() =>
      ToolConfirmation.fromResponseDict({confirmed: 'true'}),
    );

    expect(error.message).toContain("an invalid 'confirmed'");
  });

  it('names every unknown key it refused', () => {
    const error = rejection(() =>
      ToolConfirmation.fromResponseDict({confirmd: true, hnit: 'h'}),
    );

    expect(error.message).toBe(
      'ToolConfirmation received unknown key(s): confirmd, hnit.',
    );
  });

  it('reports an unknown key and a wrong type together', () => {
    const error = rejection(() =>
      ToolConfirmation.fromResponseDict({confirmd: true, hint: 42}),
    );

    expect(error.message).toContain('unknown key(s): confirmd');
    expect(error.message).toContain("an invalid 'hint'");
  });

  it('keeps the JSON failure as the cause', () => {
    const error = rejection(() =>
      ToolConfirmation.fromResponseDict({response: '{"confirmed": tru}'}),
    );

    expect(error.cause).toBeInstanceOf(SyntaxError);
  });

  it('keeps the schema failure as the cause', () => {
    const error = rejection(() =>
      ToolConfirmation.fromResponseDict({unexpected: 'value'}),
    );

    expect(error.cause).toBeInstanceOf(Error);
    expect(error.cause).toHaveProperty('issues');
  });
});

describe('IntentMismatchError', () => {
  it('names the call and the failed check, without any argument values', () => {
    const error = new IntentMismatchError({
      reason: 'arguments_mismatch',
      functionCallId: 'orig-1',
    });

    expect(error.message).toBe(
      "Tool confirmation rejected for function call 'orig-1': arguments_mismatch.",
    );
    expect(error.reason).toBe('arguments_mismatch');
    expect(error.functionCallId).toBe('orig-1');
    expect(error.name).toBe('IntentMismatchError');
  });

  it('omits the call when the request never named one', () => {
    const error = new IntentMismatchError({reason: 'malformed_request'});

    expect(error.message).toBe(
      'Tool confirmation rejected: malformed_request.',
    );
    expect(error.functionCallId).toBeUndefined();
  });

  it('survives instanceof and the name-based guard', () => {
    const error = new IntentMismatchError({reason: 'unregistered_tool'});

    expect(error).toBeInstanceOf(IntentMismatchError);
    expect(error).toBeInstanceOf(Error);
    expect(isIntentMismatchError(error)).toBe(true);
  });

  it('does not match an unrelated error or a non-error', () => {
    expect(isIntentMismatchError(new Error('nope'))).toBe(false);
    expect(isIntentMismatchError('IntentMismatchError')).toBe(false);
  });
});
