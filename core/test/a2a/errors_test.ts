/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  A2AClientError,
  AgentCardResolutionError,
  isA2AClientError,
  isAgentCardResolutionError,
} from '@google/adk';
import {describe, expect, it} from 'vitest';
import {toA2AClientError} from '../../src/a2a/errors.js';

describe('AgentCardResolutionError', () => {
  it('is an Error carrying the given name and message', () => {
    const err = new AgentCardResolutionError('boom');

    expect(err).toBeInstanceOf(AgentCardResolutionError);
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('AgentCardResolutionError');
    expect(err.message).toBe('boom');
  });

  it('keeps the original failure reachable as cause', () => {
    const inner = new Error('root cause');

    expect(new AgentCardResolutionError('boom', {cause: inner}).cause).toBe(
      inner,
    );
  });

  it('captures a stack naming the class', () => {
    const err = new AgentCardResolutionError('boom');

    expect(err.stack).toContain('AgentCardResolutionError: boom');
  });

  it('is not an A2AClientError', () => {
    expect(new AgentCardResolutionError('boom')).not.toBeInstanceOf(
      A2AClientError,
    );
  });
});

describe('A2AClientError', () => {
  it('is an Error carrying the given name and message', () => {
    const err = new A2AClientError('boom');

    expect(err).toBeInstanceOf(A2AClientError);
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('A2AClientError');
    expect(err.message).toBe('boom');
  });

  it('keeps the original failure reachable as cause', () => {
    const inner = new Error('root cause');

    expect(new A2AClientError('boom', {cause: inner}).cause).toBe(inner);
  });

  it('captures a stack naming the class', () => {
    const err = new A2AClientError('boom');

    expect(err.stack).toContain('A2AClientError: boom');
  });

  it('is not an AgentCardResolutionError', () => {
    expect(new A2AClientError('boom')).not.toBeInstanceOf(
      AgentCardResolutionError,
    );
  });
});

describe('isAgentCardResolutionError', () => {
  it('accepts an AgentCardResolutionError', () => {
    expect(
      isAgentCardResolutionError(new AgentCardResolutionError('boom')),
    ).toBe(true);
  });

  it('rejects another error type, a plain error and non-error values', () => {
    expect(isAgentCardResolutionError(new A2AClientError('boom'))).toBe(false);
    expect(isAgentCardResolutionError(new Error('boom'))).toBe(false);
    expect(isAgentCardResolutionError(undefined)).toBe(false);
    expect(isAgentCardResolutionError(null)).toBe(false);
    expect(isAgentCardResolutionError('a string')).toBe(false);
  });

  it('rejects a non-error object that merely carries the name', () => {
    expect(isAgentCardResolutionError({name: 'AgentCardResolutionError'})).toBe(
      false,
    );
  });
});

describe('isA2AClientError', () => {
  it('accepts an A2AClientError', () => {
    expect(isA2AClientError(new A2AClientError('boom'))).toBe(true);
  });

  it('rejects another error type, a plain error and non-error values', () => {
    expect(isA2AClientError(new AgentCardResolutionError('boom'))).toBe(false);
    expect(isA2AClientError(new Error('boom'))).toBe(false);
    expect(isA2AClientError(undefined)).toBe(false);
    expect(isA2AClientError(null)).toBe(false);
    expect(isA2AClientError('a string')).toBe(false);
  });

  it('rejects a non-error object that merely carries the name', () => {
    expect(isA2AClientError({name: 'A2AClientError'})).toBe(false);
  });
});

describe('toA2AClientError', () => {
  it('wraps a plain error, keeping the message and attaching the cause', () => {
    const inner = new Error('transport down');

    const err = toA2AClientError(inner);

    expect(isA2AClientError(err)).toBe(true);
    expect(err.message).toBe('transport down');
    expect(err.cause).toBe(inner);
  });

  it('stringifies a thrown non-error value', () => {
    const err = toA2AClientError('plain string');

    expect(err.message).toBe('plain string');
    expect(err.cause).toBe('plain string');
  });

  it('returns an already typed error unchanged', () => {
    const typed = new A2AClientError('already typed');

    expect(toA2AClientError(typed)).toBe(typed);
  });
});
