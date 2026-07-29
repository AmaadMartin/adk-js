/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  BaseUserSimulatorConfig,
  NextUserMessage,
  registerUserSimulator,
  SIMULATOR_BY_CONFIG_TYPE,
  Status,
  UserSimulator,
} from '@google/adk';
import {afterEach, describe, expect, it} from 'vitest';

const IFF_ERROR =
  'A user_message should be provided if and only if the status is SUCCESS';

describe('NextUserMessage', () => {
  it('rejects SUCCESS without a message', () => {
    expect(() => new NextUserMessage({status: Status.SUCCESS})).toThrow(
      IFF_ERROR,
    );
  });

  it('rejects a non-SUCCESS status with a message', () => {
    expect(
      () =>
        new NextUserMessage({
          status: Status.TURN_LIMIT_REACHED,
          userMessage: {},
        }),
    ).toThrow(IFF_ERROR);
  });

  it('accepts SUCCESS with a message and non-SUCCESS without', () => {
    expect(
      () => new NextUserMessage({status: Status.SUCCESS, userMessage: {}}),
    ).not.toThrow();
    expect(
      () => new NextUserMessage({status: Status.TURN_LIMIT_REACHED}),
    ).not.toThrow();
  });
});

class FakeConfig extends BaseUserSimulatorConfig {}
class FakeSimulator extends UserSimulator {}
class AlternativeFakeSimulator extends UserSimulator {}

describe('registerUserSimulator', () => {
  afterEach(() => {
    SIMULATOR_BY_CONFIG_TYPE.delete(FakeConfig);
  });

  it('writes the mapping to the shared registry', () => {
    registerUserSimulator(FakeConfig, FakeSimulator);
    expect(SIMULATOR_BY_CONFIG_TYPE.get(FakeConfig)).toBe(FakeSimulator);
  });

  it('overwrites an existing entry when re-registered', () => {
    registerUserSimulator(FakeConfig, FakeSimulator);
    registerUserSimulator(FakeConfig, AlternativeFakeSimulator);
    expect(SIMULATOR_BY_CONFIG_TYPE.get(FakeConfig)).toBe(
      AlternativeFakeSimulator,
    );
  });
});

describe('UserSimulator base', () => {
  it('throws for unimplemented methods', async () => {
    const simulator = new FakeSimulator();
    await expect(simulator.getNextUserMessage([])).rejects.toThrow(
      'Not implemented.',
    );
    expect(() => simulator.getSimulationEvaluator()).toThrow(
      'Not implemented.',
    );
  });
});
