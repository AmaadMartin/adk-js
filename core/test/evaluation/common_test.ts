/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  evalModel,
  isInputValidationError,
  type InputValidationError,
} from '@google/adk';
import {describe, expect, it} from 'vitest';
import {z, ZodError} from 'zod';

/** A value the schema must not describe, to prove it passes by reference. */
interface Opaque {
  readonly handle: string;
}

const model = evalModel(
  {
    textProperty: z.string(),
    numSamples: z.number().default(5),
    passthrough: z.custom<Opaque>().optional(),
  },
  {name: 'Sample'},
);

function catchValidationError(run: () => unknown): InputValidationError {
  try {
    run();
  } catch (e: unknown) {
    if (isInputValidationError(e)) {
      return e;
    }
    expect.fail(`Expected an InputValidationError, got ${String(e)}.`);
  }
  expect.fail('Expected an InputValidationError, but nothing was thrown.');
}

describe('evalModel', () => {
  it('accepts the camelCase spelling of a field', () => {
    expect(model.parse({textProperty: 'a'})).toEqual({
      textProperty: 'a',
      numSamples: 5,
    });
  });

  it('accepts the snake_case alias of a field', () => {
    expect(model.parse({text_property: 'a', num_samples: 7})).toEqual({
      textProperty: 'a',
      numSamples: 7,
    });
  });

  it('rejects a payload that supplies both spellings of one field', () => {
    const error = catchValidationError(() =>
      model.parse({textProperty: 'a', text_property: 'b'}),
    );

    expect(error.message).toContain('text_property');
  });

  it('rejects an unrecognized key by default', () => {
    const error = catchValidationError(() =>
      model.parse({textProperty: 'a', surprise: 1}),
    );

    expect(error.message).toBe('Invalid Sample: Unrecognized key: "surprise"');
  });

  it('keeps an unrecognized key when extraKeys allows it', () => {
    const loose = evalModel(
      {textProperty: z.string()},
      {name: 'Loose', extraKeys: 'allow'},
    );

    expect(loose.parse({textProperty: 'a', surprise: 1})).toEqual({
      textProperty: 'a',
      surprise: 1,
    });
  });

  it('prefers an explicit alias over the derived snake_case one', () => {
    const aliased = evalModel(
      {metricName1: z.string()},
      {name: 'Aliased', aliases: {metricName1: 'metric_name_1'}},
    );

    expect(aliased.parse({metric_name_1: 'a'})).toEqual({metricName1: 'a'});
    expect(() => aliased.parse({metric_name1: 'a'})).toThrow(
      'Unrecognized key: "metric_name1"',
    );
  });

  it('passes a custom field through by reference', () => {
    const passthrough: Opaque = {handle: 'h'};

    expect(model.parse({textProperty: 'a', passthrough}).passthrough).toBe(
      passthrough,
    );
  });

  it('rejects a payload that is not an object', () => {
    const error = catchValidationError(() => model.parse('not an object'));

    expect(error.message).toContain('Invalid Sample: ');
  });

  it('rejects an array payload', () => {
    expect(() => model.parse([{textProperty: 'a'}])).toThrow('Invalid Sample:');
  });

  it('names the field path of a failing value', () => {
    const error = catchValidationError(() => model.parse({textProperty: 7}));

    expect(error.message).toBe(
      'Invalid Sample: textProperty: Invalid input: expected string, received number',
    );
  });

  it('joins several issues with a semicolon', () => {
    const error = catchValidationError(() =>
      model.parse({textProperty: 7, numSamples: 'many'}),
    );

    expect(error.message.split('; ')).toHaveLength(2);
    expect(error.message).toContain('textProperty: ');
    expect(error.message).toContain('numSamples: ');
  });

  it('sets the cause to the underlying ZodError', () => {
    const error = catchValidationError(() => model.parse({}));

    expect(error.cause).toBeInstanceOf(ZodError);
  });

  it('exposes a schema that can be embedded in another model', () => {
    const outer = evalModel({inner: model.schema}, {name: 'Outer'});

    expect(outer.parse({inner: {text_property: 'a'}})).toEqual({
      inner: {textProperty: 'a', numSamples: 5},
    });
  });
});
