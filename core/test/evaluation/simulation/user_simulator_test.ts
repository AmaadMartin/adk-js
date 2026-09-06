/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  getRegisteredUserSimulator,
  NextUserMessage,
  registeredUserSimulatorTypes,
  registerUserSimulator,
  unregisterUserSimulator,
  UserSimulator,
  UserSimulatorFactory,
  UserSimulatorStatus,
  validateNextUserMessage,
} from '@google/adk';
import {describe, expect, it} from 'vitest';

const IFF_ERROR =
  'A user_message should be provided if and only if the status is SUCCESS';

/** A simulator whose only job is to be distinguishable by identity. */
function fakeSimulator(label: string): UserSimulator {
  return {
    async getNextUserMessage(): Promise<NextUserMessage> {
      return {
        status: UserSimulatorStatus.SUCCESS,
        userMessage: {role: 'user', parts: [{text: label}]},
      };
    },
  };
}

/** A factory that always returns the same labelled simulator. */
function fakeFactory(label: string): UserSimulatorFactory {
  const simulator = fakeSimulator(label);
  return () => simulator;
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

/**
 * Ported from adk-python
 * `tests/unittests/evaluation/simulation/test_user_simulator.py`, read at
 * `main` (commit a3bd11152db6562054db1c509ec44509436d99e7). The `it` titles
 * keep the Python test names so the two suites stay comparable.
 */
describe('user_simulator ported reference tests', () => {
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
    const factory = fakeFactory('fake_sim');
    try {
      registerUserSimulator('fake_sim', factory);

      expect(getRegisteredUserSimulator('fake_sim')).toBe(factory);
    } finally {
      unregisterUserSimulator('fake_sim');
    }
  });

  it('test_register_user_simulator_overwrites_existing_entry', () => {
    const first = fakeFactory('first');
    const second = fakeFactory('second');
    try {
      registerUserSimulator('fake_sim', first);
      registerUserSimulator('fake_sim', second);

      expect(getRegisteredUserSimulator('fake_sim')).toBe(second);
    } finally {
      unregisterUserSimulator('fake_sim');
    }
  });
});

describe('the user simulator registry', () => {
  it('reports no factory for an unregistered discriminator', () => {
    expect(getRegisteredUserSimulator('never_registered')).toBeUndefined();
  });

  it('lists the registered discriminators sorted', () => {
    try {
      registerUserSimulator('zulu', fakeFactory('zulu'));
      registerUserSimulator('alpha', fakeFactory('alpha'));
      registerUserSimulator('mike', fakeFactory('mike'));

      expect(registeredUserSimulatorTypes()).toEqual(['alpha', 'mike', 'zulu']);
    } finally {
      unregisterUserSimulator('zulu');
      unregisterUserSimulator('alpha');
      unregisterUserSimulator('mike');
    }
  });

  it('reports whether unregistering removed anything', () => {
    registerUserSimulator('short_lived', fakeFactory('short_lived'));

    expect(unregisterUserSimulator('short_lived')).toBe(true);
    expect(unregisterUserSimulator('short_lived')).toBe(false);
    expect(registeredUserSimulatorTypes()).toEqual([]);
  });
});
