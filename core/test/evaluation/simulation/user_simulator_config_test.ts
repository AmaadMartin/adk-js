/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  BaseUserSimulatorConfig,
  EvalModel,
  InputValidationError,
  UserSimulator,
  UserSimulatorFactory,
  UserSimulatorStatus,
  evalModel,
  optionalField,
  parseBaseUserSimulatorConfig,
  registerUserSimulator,
  registeredUserSimulatorTypes,
  unpackUserSimulatorConfig,
} from '@google/adk';
import {describe, expect, it} from 'vitest';
import {z} from 'zod';

const BASE_CONFIG_ERROR = 'Expect config of type `BaseUserSimulatorConfig`.';

/** The config of a simulator that needs a model and a turn budget. */
interface FakeSimulatorConfig extends BaseUserSimulatorConfig {
  type: 'fake_sim';
  model: string;
  maxAllowedInvocations?: number;
}

const fakeSimulatorConfigModel: EvalModel<FakeSimulatorConfig> = evalModel(
  {
    type: z.literal('fake_sim'),
    model: z.string(),
    maxAllowedInvocations: optionalField(z.number()),
  },
  {name: 'FakeSimulatorConfig', extraKeys: 'allow'},
);

/** A simulator that ends the conversation on its first turn. */
function stopImmediately(): UserSimulator {
  return {
    async getNextUserMessage() {
      return {status: UserSimulatorStatus.STOP_SIGNAL_DETECTED};
    },
  };
}

describe('parseBaseUserSimulatorConfig', () => {
  it('accepts a config that names no simulator', () => {
    expect(parseBaseUserSimulatorConfig({})).toEqual({});
  });

  it('accepts a config that names one', () => {
    expect(parseBaseUserSimulatorConfig({type: 'llm_backed'})).toEqual({
      type: 'llm_backed',
    });
  });

  it('keeps the keys the base shape does not name', () => {
    expect(
      parseBaseUserSimulatorConfig({type: 'fake_sim', model: 'gemini-2.5-pro'}),
    ).toEqual({type: 'fake_sim', model: 'gemini-2.5-pro'});
  });

  it.each([
    ['a string', 'not a config'],
    ['a number', 7],
    ['null', null],
  ])('rejects %s', (_name, raw) => {
    expect(() => parseBaseUserSimulatorConfig(raw)).toThrow(
      InputValidationError,
    );
    expect(() => parseBaseUserSimulatorConfig(raw)).toThrow(BASE_CONFIG_ERROR);
  });

  it('rejects a type that is not a string', () => {
    expect(() => parseBaseUserSimulatorConfig({type: 7})).toThrow(
      BASE_CONFIG_ERROR,
    );
  });

  it('keeps the schema error as the cause', () => {
    let cause: unknown;
    try {
      parseBaseUserSimulatorConfig('not a config');
      expect.fail('parseBaseUserSimulatorConfig should have thrown');
    } catch (e: unknown) {
      cause = e instanceof Error ? e.cause : undefined;
    }

    expect(cause).toBeInstanceOf(z.ZodError);
  });
});

describe('unpackUserSimulatorConfig', () => {
  it('narrows a config the concrete model accepts', () => {
    const unpacked = unpackUserSimulatorConfig(
      {type: 'fake_sim', model: 'gemini-2.5-pro'},
      fakeSimulatorConfigModel,
    );

    expect(unpacked.model).toBe('gemini-2.5-pro');
  });

  it('accepts the snake_case spelling of a field', () => {
    const unpacked = unpackUserSimulatorConfig(
      {type: 'fake_sim', model: 'gemini-2.5-pro', max_allowed_invocations: 4},
      fakeSimulatorConfigModel,
    );

    expect(unpacked.maxAllowedInvocations).toBe(4);
  });

  it('names the concrete model when a required field is missing', () => {
    expect(() =>
      unpackUserSimulatorConfig({type: 'fake_sim'}, fakeSimulatorConfigModel),
    ).toThrow('Expect config of type `FakeSimulatorConfig`.');
  });

  it('rejects a config whose discriminator belongs to another simulator', () => {
    expect(() =>
      unpackUserSimulatorConfig(
        {type: 'other_sim', model: 'gemini-2.5-pro'},
        fakeSimulatorConfigModel,
      ),
    ).toThrow('Expect config of type `FakeSimulatorConfig`.');
  });
});

describe('registeredUserSimulatorTypes', () => {
  it('returns the registered discriminators in sorted order', () => {
    const factory: UserSimulatorFactory = () => stopImmediately();
    registerUserSimulator('zebra_sim', factory);
    registerUserSimulator('alpha_sim', factory);
    registerUserSimulator('middle_sim', factory);

    expect(registeredUserSimulatorTypes()).toEqual([
      'alpha_sim',
      'middle_sim',
      'zebra_sim',
    ]);
  });
});
