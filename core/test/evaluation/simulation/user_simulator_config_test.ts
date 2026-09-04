/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  BaseUserSimulatorConfig,
  EvalModel,
  evalModel,
  InputValidationError,
  optionalField,
  parseBaseUserSimulatorConfig,
  unpackUserSimulatorConfig,
} from '@google/adk';
import {describe, expect, it} from 'vitest';
import {z} from 'zod';

/** A concrete config, standing in for one a real simulator would ship. */
interface DemoUserSimulatorConfig extends BaseUserSimulatorConfig {
  type: 'demo';
  maxTurns: number;
  stopSignal?: string;
}

const demoUserSimulatorConfigModel: EvalModel<DemoUserSimulatorConfig> =
  evalModel(
    {
      type: z.literal('demo'),
      maxTurns: z.number(),
      stopSignal: optionalField(z.string()),
    },
    {name: 'DemoUserSimulatorConfig', extraKeys: 'allow'},
  );

/** Runs `fn` and returns the error it throws. */
function captureError(fn: () => unknown): Error {
  try {
    fn();
  } catch (error: unknown) {
    if (error instanceof Error) {
      return error;
    }
    expect.fail(`expected an Error, got ${String(error)}`);
  }
  expect.fail('expected the call to throw');
}

describe('parseBaseUserSimulatorConfig', () => {
  it('accepts an empty config', () => {
    expect(parseBaseUserSimulatorConfig({})).toEqual({});
  });

  it('accepts a config naming a discriminator', () => {
    expect(parseBaseUserSimulatorConfig({type: 'demo'})).toEqual({
      type: 'demo',
    });
  });

  it('keeps the keys the base does not name', () => {
    expect(
      parseBaseUserSimulatorConfig({type: 'demo', maxTurns: 4, model: 'm'}),
    ).toEqual({type: 'demo', maxTurns: 4, model: 'm'});
  });

  it('rejects a non-string discriminator', () => {
    expect(() => parseBaseUserSimulatorConfig({type: 7})).toThrow(
      InputValidationError,
    );
    expect(() => parseBaseUserSimulatorConfig({type: 7})).toThrow(
      'Expect config of type `BaseUserSimulatorConfig`.',
    );
  });

  it('rejects a value that is not an object at all', () => {
    expect(() => parseBaseUserSimulatorConfig('not a config')).toThrow(
      'Expect config of type `BaseUserSimulatorConfig`.',
    );
  });

  it('keeps the schema error naming the rejected field as the cause', () => {
    const error = captureError(() => parseBaseUserSimulatorConfig({type: 7}));

    expect(error.cause).toMatchObject({issues: [{path: ['type']}]});
  });
});

describe('unpackUserSimulatorConfig', () => {
  it('narrows a config the concrete model accepts', () => {
    const config = unpackUserSimulatorConfig(
      {type: 'demo', maxTurns: 3},
      demoUserSimulatorConfigModel,
    );

    expect(config.maxTurns).toBe(3);
    expect(config.type).toBe('demo');
  });

  it('accepts the snake_case spelling of a camelCase field', () => {
    const config = unpackUserSimulatorConfig(
      {type: 'demo', max_turns: 3, stop_signal: 'bye'},
      demoUserSimulatorConfigModel,
    );

    expect(config.maxTurns).toBe(3);
    expect(config.stopSignal).toBe('bye');
  });

  it('names the concrete model when a required field is missing', () => {
    expect(() =>
      unpackUserSimulatorConfig({type: 'demo'}, demoUserSimulatorConfigModel),
    ).toThrow('Expect config of type `DemoUserSimulatorConfig`.');
  });

  it('rejects a config whose discriminator belongs to another simulator', () => {
    expect(() =>
      unpackUserSimulatorConfig(
        {type: 'other', maxTurns: 3},
        demoUserSimulatorConfigModel,
      ),
    ).toThrow('Expect config of type `DemoUserSimulatorConfig`.');
  });

  it('keeps the schema error naming the rejected field as the cause', () => {
    const error = captureError(() =>
      unpackUserSimulatorConfig({type: 'demo'}, demoUserSimulatorConfigModel),
    );

    expect(error.cause).toMatchObject({issues: [{path: ['maxTurns']}]});
  });
});
