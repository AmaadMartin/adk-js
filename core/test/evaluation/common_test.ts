/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  EvalModel,
  InputValidationError,
  evalModel,
  optionalField,
} from '@google/adk';
import {describe, expect, it} from 'vitest';
import {z} from 'zod';

interface Scenario {
  startingPrompt: string;
  maxTurns?: number;
}

const scenarioModel: EvalModel<Scenario> = evalModel(
  {startingPrompt: z.string(), maxTurns: optionalField(z.number())},
  {name: 'Scenario'},
);

const looseScenarioModel: EvalModel<Scenario> = evalModel(
  {startingPrompt: z.string(), maxTurns: optionalField(z.number())},
  {name: 'LooseScenario', extraKeys: 'allow'},
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

describe('evalModel', () => {
  it('reports the name it was built with', () => {
    expect(scenarioModel.name).toBe('Scenario');
  });

  it('accepts canonical camelCase keys', () => {
    expect(scenarioModel.parse({startingPrompt: 'hi', maxTurns: 2})).toEqual({
      startingPrompt: 'hi',
      maxTurns: 2,
    });
  });

  it('accepts snake_case alias keys into the same properties', () => {
    expect(scenarioModel.parse({starting_prompt: 'hi', max_turns: 2})).toEqual({
      startingPrompt: 'hi',
      maxTurns: 2,
    });
  });

  it('leaves an absent optional field undefined', () => {
    expect(
      scenarioModel.parse({startingPrompt: 'hi'}).maxTurns,
    ).toBeUndefined();
  });

  it('rejects an unrecognized key and names it', () => {
    expect(() => scenarioModel.parse({startingPrompt: 'hi', nope: 1})).toThrow(
      InputValidationError,
    );
    expect(() => scenarioModel.parse({startingPrompt: 'hi', nope: 1})).toThrow(
      /Invalid Scenario:.*nope/,
    );
  });

  it('uses an explicit alias in place of the snake_case spelling', () => {
    const aliased: EvalModel<{metricName1: string}> = evalModel(
      {metricName1: z.string()},
      {name: 'Aliased', aliases: {metricName1: 'metric_name_1'}},
    );

    expect(aliased.parse({metric_name_1: 'x'})).toEqual({metricName1: 'x'});
    expect(aliased.dump({metricName1: 'x'}, {byAlias: true})).toEqual({
      metric_name_1: 'x',
    });
  });

  it('keeps an unrecognized key when extraKeys allows it', () => {
    expect(looseScenarioModel.parse({startingPrompt: 'hi', nope: 1})).toEqual({
      startingPrompt: 'hi',
      nope: 1,
    });
  });

  it('names the property of a failing field', () => {
    expect(() => scenarioModel.parse({startingPrompt: 7})).toThrow(
      /Invalid Scenario: startingPrompt:/,
    );
  });

  it('joins several problems with a semicolon', () => {
    const error = captureError(() =>
      scenarioModel.parse({startingPrompt: 7, maxTurns: 'x'}),
    );

    expect(error.message).toContain('; ');
  });

  it('reports a whole-value problem without a property path', () => {
    const error = captureError(() => scenarioModel.parse('not an object'));

    expect(error.message).toMatch(/^Invalid Scenario: Invalid input/);
  });

  it('keeps the schema error as the cause', () => {
    const error = captureError(() => scenarioModel.parse({}));

    expect(error.cause).toMatchObject({issues: [{path: ['startingPrompt']}]});
  });
});

/**
 * `optionalField` builds a one-way transform, which `schema.encode` cannot
 * reverse, so the dump fixture uses plain optionality instead.
 */
const turnModel: EvalModel<{startingPrompt: string; maxTurns?: number}> =
  evalModel(
    {startingPrompt: z.string(), maxTurns: z.number().optional()},
    {name: 'Turn'},
  );

describe('EvalModel.dump', () => {
  it('emits canonical camelCase keys by default', () => {
    expect(turnModel.dump({startingPrompt: 'hi', maxTurns: 2})).toEqual({
      startingPrompt: 'hi',
      maxTurns: 2,
    });
  });

  it('emits snake_case alias keys with byAlias', () => {
    expect(
      turnModel.dump({startingPrompt: 'hi', maxTurns: 2}, {byAlias: true}),
    ).toEqual({starting_prompt: 'hi', max_turns: 2});
  });
});
