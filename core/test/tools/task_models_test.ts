/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Behaviour ported from google/adk-python
 * `src/google/adk/agents/llm/task/_task_models.py` (main).
 *
 * adk-python ships no test module for that file, so these cases are derived
 * from the pydantic model definitions rather than translated from reference
 * tests.
 */

import {InputValidationError, Logger, setLogger} from '@google/adk';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {
  asTaskRequest,
  parseDefaultTaskInput,
  parseTaskRequest,
  parseTaskResult,
} from '../../src/tools/task_models.js';
import {resetLogger} from '../../src/utils/logger.js';

/** Collects the messages the module under test logs at error level. */
function captureErrorLog(): string[] {
  const messages: string[] = [];
  const collector: Logger = {
    setLogLevel: () => {},
    log: () => {},
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: (...args: unknown[]) => messages.push(args.join(' ')),
  };
  setLogger(collector);
  return messages;
}

describe('parseTaskRequest', () => {
  it('accepts the snake_case spelling adk-python writes', () => {
    expect(parseTaskRequest({agent_name: 'researcher', input: {}})).toEqual({
      agentName: 'researcher',
      input: {},
    });
  });

  it('accepts the camelCase spelling', () => {
    expect(parseTaskRequest({agentName: 'researcher', input: {}})).toEqual({
      agentName: 'researcher',
      input: {},
    });
  });

  it('rejects a payload carrying both spellings', () => {
    expect(() =>
      parseTaskRequest({agent_name: 'a', agentName: 'b', input: {}}),
    ).toThrow(/agent_name/);
  });

  it('rejects an unknown key', () => {
    expect(() => parseTaskRequest({agent_name: 'a', input: {}, x: 1})).toThrow(
      InputValidationError,
    );
  });

  it('rejects a missing input', () => {
    expect(() => parseTaskRequest({agent_name: 'a'})).toThrow(
      'input must be an object.',
    );
  });

  it('rejects an input that is not an object', () => {
    expect(() => parseTaskRequest({agent_name: 'a', input: 's'})).toThrow(
      'input must be an object.',
    );
  });

  it('rejects an agent name that is not a string', () => {
    expect(() => parseTaskRequest({agent_name: 1, input: {}})).toThrow(
      'agentName must be a string.',
    );
  });

  it('rejects a value that is not an object', () => {
    expect(() => parseTaskRequest('nope')).toThrow(InputValidationError);
  });

  it('preserves the keys of a nested input payload verbatim', () => {
    const input = {a_b: 1, nested: {c_d: 2, deeper: {e_f: [{g_h: 3}]}}};

    expect(parseTaskRequest({agent_name: 'a', input})).toEqual({
      agentName: 'a',
      input: {a_b: 1, nested: {c_d: 2, deeper: {e_f: [{g_h: 3}]}}},
    });
  });

  it('returns a frozen request', () => {
    const request = parseTaskRequest({agentName: 'a', input: {}});

    expect(Object.isFrozen(request)).toBe(true);
    expect(() => Object.assign(request, {agentName: 'b'})).toThrow(TypeError);
  });
});

describe('parseTaskResult', () => {
  it('rejects a missing output', () => {
    expect(() => parseTaskResult({})).toThrow('output is required.');
  });

  it('accepts a null output', () => {
    expect(parseTaskResult({output: null})).toEqual({output: null});
  });

  it('accepts an output of any type', () => {
    expect(parseTaskResult({output: 5})).toEqual({output: 5});
    expect(parseTaskResult({output: {nested: true}})).toEqual({
      output: {nested: true},
    });
  });

  it('rejects an unknown key', () => {
    expect(() => parseTaskResult({output: 5, z: 1})).toThrow(
      InputValidationError,
    );
  });

  it('returns a frozen result', () => {
    const result = parseTaskResult({output: 5});

    expect(Object.isFrozen(result)).toBe(true);
    expect(() => Object.assign(result, {output: 6})).toThrow(TypeError);
  });
});

describe('parseDefaultTaskInput', () => {
  it('accepts an empty payload', () => {
    expect(parseDefaultTaskInput({})).toEqual({});
  });

  it('accepts both fields', () => {
    expect(parseDefaultTaskInput({goal: 'g', background: 'b'})).toEqual({
      goal: 'g',
      background: 'b',
    });
  });

  it('normalizes a null field to undefined', () => {
    const parsed = parseDefaultTaskInput({goal: null, background: 'b'});

    expect(parsed.goal).toBeUndefined();
    expect(parsed.background).toBe('b');
  });

  it('rejects an unknown key', () => {
    expect(() => parseDefaultTaskInput({nope: 1})).toThrow(
      InputValidationError,
    );
  });

  it('rejects a goal that is not a string', () => {
    expect(() => parseDefaultTaskInput({goal: 1})).toThrow(
      'goal must be a string.',
    );
  });

  it('rejects a background that is not a string', () => {
    expect(() => parseDefaultTaskInput({background: 1})).toThrow(
      'background must be a string.',
    );
  });

  it('returns a frozen input', () => {
    const parsed = parseDefaultTaskInput({goal: 'g'});

    expect(Object.isFrozen(parsed)).toBe(true);
    expect(() => Object.assign(parsed, {goal: 'other'})).toThrow(TypeError);
  });
});

describe('asTaskRequest', () => {
  let logged: string[];

  beforeEach(() => {
    logged = captureErrorLog();
  });

  afterEach(() => {
    resetLogger();
  });

  it('returns an equal request for a value that is already valid', () => {
    const request = parseTaskRequest({agentName: 'a', input: {topic_id: 42}});

    expect(asTaskRequest(request)).toEqual(request);
    expect(logged).toEqual([]);
  });

  it('normalizes the snake_case spelling', () => {
    expect(asTaskRequest({agent_name: 'a', input: {}})).toEqual({
      agentName: 'a',
      input: {},
    });
    expect(logged).toEqual([]);
  });

  it('throws without logging when an object fails validation', () => {
    expect(() => asTaskRequest({agentName: 'a'})).toThrow(InputValidationError);
    expect(logged).toEqual([]);
  });

  it.each([
    {label: 'a string', value: 'nope', typeName: 'string'},
    {label: 'a number', value: 7, typeName: 'number'},
    {label: 'null', value: null, typeName: 'null'},
    {label: 'an array', value: [], typeName: 'Array'},
  ])('logs the received type and throws for $label', ({value, typeName}) => {
    expect(() => asTaskRequest(value)).toThrow(InputValidationError);

    expect(logged).toHaveLength(1);
    expect(logged[0]).toContain(typeName);
  });
});
