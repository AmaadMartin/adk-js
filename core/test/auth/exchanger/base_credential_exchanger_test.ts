/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {AuthCredentialMissingError, CredentialExchangeError} from '@google/adk';
import {describe, expect, it} from 'vitest';

describe('AuthCredentialMissingError', () => {
  it('carries the message it was constructed with', () => {
    const error = new AuthCredentialMissingError('Test missing credential');

    expect(error.message).toBe('Test missing credential');
    expect(String(error)).toContain('Test missing credential');
  });

  it('is an Error but not a CredentialExchangeError', () => {
    const error = new AuthCredentialMissingError('Test missing credential');

    expect(error.name).toBe('AuthCredentialMissingError');
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(CredentialExchangeError);
  });
});
