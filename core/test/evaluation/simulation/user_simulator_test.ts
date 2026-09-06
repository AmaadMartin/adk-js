/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {UserSimulatorStatus, validateNextUserMessage} from '@google/adk';
import {describe, expect, it} from 'vitest';

const IFF_ERROR =
  'A user_message should be provided if and only if the status is SUCCESS';

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
