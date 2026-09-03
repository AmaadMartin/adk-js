/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  evalModel,
  InputValidationError,
  isInputValidationError,
} from '@google/adk';
import {Content} from '@google/genai';
import {describe, expect, it} from 'vitest';
import {z, ZodError} from 'zod';

const conversationScenario = evalModel(
  {
    startingPrompt: z.string(),
    conversationPlan: z.string(),
    userPersona: z.string().optional(),
  },
  {name: 'ConversationScenario'},
);

const isContent = (value: unknown): boolean =>
  typeof value === 'object' && value !== null && 'parts' in value;

const evalCase = evalModel(
  {
    caseId: z.string(),
    rootScenario: conversationScenario.schema,
    scenarios: z.array(conversationScenario.schema),
    finalResponse: z.custom<Content>(isContent),
    rawScore: z.number(),
  },
  {name: 'EvalCase'},
);

// `metric_name_1` aliases to `metricName1` in adk-python, whose snake_case
// form is `metric_name1`. The override restores the adk-python spelling.
const metricResult = evalModel(
  {metricName1: z.string()},
  {name: 'MetricResult', aliases: {metricName1: 'metric_name_1'}},
);

const derivedAliasMetricResult = evalModel(
  {metricName1: z.string()},
  {name: 'DerivedMetricResult'},
);

function evalCaseFixture(finalResponse: Content) {
  return {
    caseId: 'case-1',
    rootScenario: {
      startingPrompt: 'I need to book a flight.',
      conversationPlan: 'Book SFO to LAX.',
    },
    scenarios: [
      {startingPrompt: 'What can you do?', conversationPlan: 'Ask and stop.'},
    ],
    finalResponse,
    rawScore: 0.5,
  };
}

function expectInputValidationError(run: () => unknown): InputValidationError {
  try {
    run();
  } catch (error: unknown) {
    if (error instanceof InputValidationError) {
      return error;
    }
    expect.fail(`expected an InputValidationError, got ${String(error)}`);
  }
  expect.fail('expected an InputValidationError, got no error');
}

describe('evalModel parsing', () => {
  it('accepts canonical camelCase keys', () => {
    const parsed = conversationScenario.parse({
      startingPrompt: 'I need to book a flight.',
      conversationPlan: 'Book SFO to LAX.',
      userPersona: 'EVALUATOR',
    });

    expect(parsed).toEqual({
      startingPrompt: 'I need to book a flight.',
      conversationPlan: 'Book SFO to LAX.',
      userPersona: 'EVALUATOR',
    });
  });

  it('accepts snake_case alias keys into the same properties', () => {
    const parsed = conversationScenario.parse({
      starting_prompt: 'I need to book a flight.',
      conversation_plan: 'Book SFO to LAX.',
      user_persona: 'EVALUATOR',
    });

    expect(parsed).toEqual({
      startingPrompt: 'I need to book a flight.',
      conversationPlan: 'Book SFO to LAX.',
      userPersona: 'EVALUATOR',
    });
  });

  it('rejects a field supplied under both spellings, naming the alias', () => {
    const error = expectInputValidationError(() =>
      conversationScenario.parse({
        startingPrompt: 'I need to book a flight.',
        starting_prompt: 'A different prompt.',
        conversationPlan: 'Book SFO to LAX.',
      }),
    );

    expect(error.message).toContain('starting_prompt');
    expect(error.message).not.toContain('conversationPlan');
  });

  it('rejects an unrecognized key and names it', () => {
    const error = expectInputValidationError(() =>
      conversationScenario.parse({
        startingPrompt: 'I need to book a flight.',
        conversationPlan: 'Book SFO to LAX.',
        userPersonaa: 'EXPERT',
      }),
    );

    expect(error.message).toBe(
      'Invalid ConversationScenario: Unrecognized key: "userPersonaa"',
    );
  });

  it('rejects a missing required field and names the property', () => {
    const error = expectInputValidationError(() =>
      conversationScenario.parse({conversationPlan: 'Book SFO to LAX.'}),
    );

    expect(error.message).toContain('startingPrompt');
  });

  it('leaves an absent optional field undefined', () => {
    const parsed = conversationScenario.parse({
      startingPrompt: 'hi',
      conversationPlan: 'chat',
    });

    expect(parsed.userPersona).toBeUndefined();
  });

  it('rejects a value that is not an object', () => {
    const error = expectInputValidationError(() =>
      conversationScenario.parse('not an object'),
    );

    expect(error.message).toBe(
      'Invalid ConversationScenario: Invalid input: expected object, received string',
    );
  });
});

describe('evalModel arbitrary types', () => {
  const finalResponse: Content = {role: 'model', parts: [{text: 'Booked.'}]};

  it('passes an arbitrary-typed value through by reference', () => {
    const parsed = evalCase.parse(evalCaseFixture(finalResponse));

    expect(parsed.finalResponse).toBe(finalResponse);
  });

  it('rejects a value its predicate refuses, naming the field', () => {
    const error = expectInputValidationError(() =>
      evalCase.parse({...evalCaseFixture(finalResponse), finalResponse: 'hi'}),
    );

    expect(error.message).toContain('finalResponse');
  });
});

describe('evalModel nesting', () => {
  const finalResponse: Content = {role: 'model', parts: [{text: 'Booked.'}]};

  it('applies alias renaming inside a nested model', () => {
    const parsed = evalCase.parse({
      case_id: 'case-1',
      root_scenario: {
        starting_prompt: 'I need to book a flight.',
        conversation_plan: 'Book SFO to LAX.',
      },
      scenarios: [
        {starting_prompt: 'What can you do?', conversation_plan: 'Ask.'},
      ],
      final_response: finalResponse,
      raw_score: 0.5,
    });

    expect(parsed.rootScenario.startingPrompt).toBe('I need to book a flight.');
    expect(parsed.scenarios[0].conversationPlan).toBe('Ask.');
  });

  it('applies strictness inside a nested model, with the path', () => {
    const error = expectInputValidationError(() =>
      evalCase.parse({
        ...evalCaseFixture(finalResponse),
        rootScenario: {
          startingPrompt: 'hi',
          conversationPlan: 'chat',
          bogus: 1,
        },
      }),
    );

    expect(error.message).toBe(
      'Invalid EvalCase: rootScenario: Unrecognized key: "bogus"',
    );
  });

  it('applies strictness to each element of a model array, with the index', () => {
    const error = expectInputValidationError(() =>
      evalCase.parse({
        ...evalCaseFixture(finalResponse),
        scenarios: [{startingPrompt: 'hi', conversationPlan: 'chat', oops: 1}],
      }),
    );

    expect(error.message).toBe(
      'Invalid EvalCase: scenarios.0: Unrecognized key: "oops"',
    );
  });
});

describe('evalModel dumping', () => {
  const finalResponse: Content = {role: 'model', parts: [{text: 'Booked.'}]};

  it('emits canonical camelCase keys by default', () => {
    const parsed = conversationScenario.parse({
      starting_prompt: 'hi',
      conversation_plan: 'chat',
    });

    expect(conversationScenario.dump(parsed)).toEqual({
      startingPrompt: 'hi',
      conversationPlan: 'chat',
    });
  });

  it('emits snake_case alias keys with byAlias, at every level', () => {
    const parsed = evalCase.parse(evalCaseFixture(finalResponse));

    expect(evalCase.dump(parsed, {byAlias: true})).toEqual({
      case_id: 'case-1',
      root_scenario: {
        starting_prompt: 'I need to book a flight.',
        conversation_plan: 'Book SFO to LAX.',
      },
      scenarios: [
        {
          starting_prompt: 'What can you do?',
          conversation_plan: 'Ask and stop.',
        },
      ],
      final_response: finalResponse,
      raw_score: 0.5,
    });
  });

  it('never rewrites the keys inside an arbitrary-typed value', () => {
    const opaque: Content = {
      role: 'user',
      parts: [{functionCall: {name: 'book', args: {departure_city: 'SFO'}}}],
    };
    const parsed = evalCase.parse(evalCaseFixture(opaque));

    const dumped = evalCase.dump(parsed, {byAlias: true});

    expect(dumped['final_response']).toEqual({
      role: 'user',
      parts: [{functionCall: {name: 'book', args: {departure_city: 'SFO'}}}],
    });
  });

  it('round trips through both dump forms', () => {
    const parsed = evalCase.parse(evalCaseFixture(finalResponse));

    expect(evalCase.parse(evalCase.dump(parsed))).toEqual(parsed);
    expect(evalCase.parse(evalCase.dump(parsed, {byAlias: true}))).toEqual(
      parsed,
    );
  });
});

describe('evalModel aliases', () => {
  it('derives an alias that does not split a digit segment', () => {
    expect(derivedAliasMetricResult.parse({metric_name1: 'safety'})).toEqual({
      metricName1: 'safety',
    });

    const error = expectInputValidationError(() =>
      derivedAliasMetricResult.parse({metric_name_1: 'safety'}),
    );
    expect(error.message).toContain('metric_name_1');
  });

  it('lets an explicit alias override the derived one', () => {
    expect(metricResult.parse({metric_name_1: 'safety'})).toEqual({
      metricName1: 'safety',
    });
    expect(metricResult.dump({metricName1: 'safety'}, {byAlias: true})).toEqual(
      {metric_name_1: 'safety'},
    );
  });

  it('no longer accepts the derived alias once overridden', () => {
    const error = expectInputValidationError(() =>
      metricResult.parse({metric_name1: 'safety'}),
    );

    expect(error.message).toContain('metric_name1');
  });
});

describe('evalModel error reporting', () => {
  it('carries the ZodError as the cause', () => {
    const error = expectInputValidationError(() =>
      conversationScenario.parse({startingPrompt: 'hi', bogus: 1}),
    );

    const cause = error.cause;
    if (!(cause instanceof z.ZodError)) {
      expect.fail('expected the cause to be a ZodError');
    }
    expect(cause.issues.map((issue) => issue.code)).toEqual([
      'invalid_type',
      'unrecognized_keys',
    ]);
  });

  it('reports every problem in one message', () => {
    const error = expectInputValidationError(() =>
      conversationScenario.parse({startingPrompt: 'hi', bogus: 1}),
    );

    expect(error.message).toBe(
      'Invalid ConversationScenario: conversationPlan: Invalid input: expected string, received undefined; Unrecognized key: "bogus"',
    );
  });

  it('returns an unrecognized_keys issue from safeParse instead of throwing', () => {
    const result = conversationScenario.schema.safeParse({
      startingPrompt: 'hi',
      conversationPlan: 'chat',
      userPersonaa: 'EXPERT',
    });

    expect(result.success).toBe(false);
    if (result.success) {
      expect.fail('expected safeParse to fail');
    }
    expect(result.error.issues).toEqual([
      expect.objectContaining({
        code: 'unrecognized_keys',
        keys: ['userPersonaa'],
      }),
    ]);
  });

  it('returns the parsed value from safeParse on success', () => {
    const result = conversationScenario.schema.safeParse({
      starting_prompt: 'hi',
      conversation_plan: 'chat',
    });

    expect(result.success).toBe(true);
    if (!result.success) {
      expect.fail('expected safeParse to succeed');
    }
    expect(result.data.startingPrompt).toBe('hi');
  });
});

/** A value the schema must not describe, to prove it passes by reference. */
interface Opaque {
  readonly handle: string;
}

const model = evalModel(
  {
    textProperty: z.string(),
    numSamples: z.number().default(5),
    passthrough: z.custom<Opaque>().optional(),
  },
  {name: 'Sample'},
);

function catchValidationError(run: () => unknown): InputValidationError {
  try {
    run();
  } catch (e: unknown) {
    if (isInputValidationError(e)) {
      return e;
    }
    expect.fail(`Expected an InputValidationError, got ${String(e)}.`);
  }
  expect.fail('Expected an InputValidationError, but nothing was thrown.');
}

describe('evalModel', () => {
  it('accepts the camelCase spelling of a field', () => {
    expect(model.parse({textProperty: 'a'})).toEqual({
      textProperty: 'a',
      numSamples: 5,
    });
  });

  it('accepts the snake_case alias of a field', () => {
    expect(model.parse({text_property: 'a', num_samples: 7})).toEqual({
      textProperty: 'a',
      numSamples: 7,
    });
  });

  it('rejects a payload that supplies both spellings of one field', () => {
    const error = catchValidationError(() =>
      model.parse({textProperty: 'a', text_property: 'b'}),
    );

    expect(error.message).toContain('text_property');
  });

  it('rejects an unrecognized key by default', () => {
    const error = catchValidationError(() =>
      model.parse({textProperty: 'a', surprise: 1}),
    );

    expect(error.message).toBe('Invalid Sample: Unrecognized key: "surprise"');
  });

  it('keeps an unrecognized key when extraKeys allows it', () => {
    const loose = evalModel(
      {textProperty: z.string()},
      {name: 'Loose', extraKeys: 'allow'},
    );

    expect(loose.parse({textProperty: 'a', surprise: 1})).toEqual({
      textProperty: 'a',
      surprise: 1,
    });
  });

  it('passes a custom field through by reference', () => {
    const passthrough: Opaque = {handle: 'h'};

    expect(model.parse({textProperty: 'a', passthrough}).passthrough).toBe(
      passthrough,
    );
  });

  it('rejects a payload that is not an object', () => {
    const error = catchValidationError(() => model.parse('not an object'));

    expect(error.message).toContain('Invalid Sample: ');
  });

  it('rejects an array payload', () => {
    expect(() => model.parse([{textProperty: 'a'}])).toThrow('Invalid Sample:');
  });

  it('names the field path of a failing value', () => {
    const error = catchValidationError(() => model.parse({textProperty: 7}));

    expect(error.message).toBe(
      'Invalid Sample: textProperty: Invalid input: expected string, received number',
    );
  });

  it('joins several issues with a semicolon', () => {
    const error = catchValidationError(() =>
      model.parse({textProperty: 7, numSamples: 'many'}),
    );

    expect(error.message.split('; ')).toHaveLength(2);
    expect(error.message).toContain('textProperty: ');
    expect(error.message).toContain('numSamples: ');
  });

  it('sets the cause to the underlying ZodError', () => {
    const error = catchValidationError(() => model.parse({}));

    expect(error.cause).toBeInstanceOf(ZodError);
  });

  it('exposes a schema that can be embedded in another model', () => {
    const outer = evalModel({inner: model.schema}, {name: 'Outer'});

    expect(outer.parse({inner: {text_property: 'a'}})).toEqual({
      inner: {textProperty: 'a', numSamples: 5},
    });
  });
});
