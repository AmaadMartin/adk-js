/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  UserSimulator,
  UserSimulatorFactory,
  UserSimulatorStatus,
  getRegisteredUserSimulator,
  registerUserSimulator,
  validateNextUserMessage,
} from '@google/adk';
import {describe, expect, it} from 'vitest';

const IFF_ERROR =
  'A user_message should be provided if and only if the status is SUCCESS';

/** A simulator that ends the conversation on its first turn. */
function stopImmediately(): UserSimulator {
  return {
    async getNextUserMessage() {
      return {status: UserSimulatorStatus.STOP_SIGNAL_DETECTED};
    },
  };
}

describe('validateNextUserMessage', () => {
  it('accepts a successful result carrying a message', () => {
    expect(() =>
      validateNextUserMessage({
        status: UserSimulatorStatus.SUCCESS,
        userMessage: {role: 'user', parts: [{text: 'hi'}]},
      }),
    ).not.toThrow();
  });

  it('accepts an unsuccessful result carrying no message', () => {
    expect(() =>
      validateNextUserMessage({
        status: UserSimulatorStatus.TURN_LIMIT_REACHED,
      }),
    ).not.toThrow();
  });

  it('rejects a successful result with no message', () => {
    expect(() =>
      validateNextUserMessage({status: UserSimulatorStatus.SUCCESS}),
    ).toThrowError(IFF_ERROR);
  });

  it('rejects an unsuccessful result that still carries a message', () => {
    expect(() =>
      validateNextUserMessage({
        status: UserSimulatorStatus.STOP_SIGNAL_DETECTED,
        userMessage: {role: 'user', parts: [{text: 'hi'}]},
      }),
    ).toThrowError(IFF_ERROR);
  });
});

describe('UserSimulatorStatus', () => {
  it('matches the status values adk-python emits', () => {
    expect(UserSimulatorStatus.SUCCESS).toBe('success');
    expect(UserSimulatorStatus.TURN_LIMIT_REACHED).toBe('turn_limit_reached');
    expect(UserSimulatorStatus.STOP_SIGNAL_DETECTED).toBe(
      'stop_signal_detected',
    );
    expect(UserSimulatorStatus.NO_MESSAGE_GENERATED).toBe(
      'no_message_generated',
    );
  });
});

// Ported from `google/adk-python` `main`,
// `tests/unittests/evaluation/simulation/test_user_simulator.py`. Each `it`
// title is the name of the reference test it came from.
describe('user_simulator ported reference tests', () => {
  const fakeSimulator: UserSimulatorFactory = () => stopImmediately();
  const alternativeFakeSimulator: UserSimulatorFactory = () =>
    stopImmediately();

  it('test_next_user_message_validation', () => {
    expect(() =>
      validateNextUserMessage({status: UserSimulatorStatus.SUCCESS}),
    ).toThrowError(IFF_ERROR);
    expect(() =>
      validateNextUserMessage({
        status: UserSimulatorStatus.TURN_LIMIT_REACHED,
        userMessage: {},
      }),
    ).toThrowError(IFF_ERROR);

    expect(() =>
      validateNextUserMessage({
        status: UserSimulatorStatus.SUCCESS,
        userMessage: {},
      }),
    ).not.toThrow();
    expect(() =>
      validateNextUserMessage({status: UserSimulatorStatus.TURN_LIMIT_REACHED}),
    ).not.toThrow();
  });

  it('test_register_user_simulator_writes_to_shared_registry', () => {
    registerUserSimulator('fake_sim', fakeSimulator);

    expect(getRegisteredUserSimulator('fake_sim')).toBe(fakeSimulator);
  });

  it('test_register_user_simulator_overwrites_existing_entry', () => {
    registerUserSimulator('overwritten_sim', fakeSimulator);
    registerUserSimulator('overwritten_sim', alternativeFakeSimulator);

    expect(getRegisteredUserSimulator('overwritten_sim')).toBe(
      alternativeFakeSimulator,
    );
  });
});
