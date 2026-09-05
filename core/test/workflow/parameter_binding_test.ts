/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Language, Schema, Type} from '@google/genai';
import {afterEach, describe, expect, it, vi} from 'vitest';
import {z as z3} from 'zod/v3';
import {z as z4} from 'zod/v4';
import {State} from '../../src/sessions/state.js';
import {logger} from '../../src/utils/logger.js';
import {SchemaLike} from '../../src/utils/schema.js';
import {
  bindParameters,
  contentToString,
  describeParameters,
  ParameterDescriptor,
  parameterFieldSchema,
} from '../../src/workflow/utils/parameter_binding.js';

/** Binds `descriptors` from session state, the `'state'` mode source. */
function bindFromState(
  descriptors: readonly ParameterDescriptor[],
  state: Record<string, unknown> = {},
  nodeInput: unknown = undefined,
): Record<string, unknown> {
  return bindParameters({
    descriptors,
    binding: 'state',
    state: new State(state),
    nodeInput,
    nodeName: 'n',
  });
}

/** Binds `descriptors` from the upstream node's output. */
function bindFromNodeInput(
  descriptors: readonly ParameterDescriptor[],
  nodeInput: unknown,
): Record<string, unknown> {
  return bindParameters({
    descriptors,
    binding: 'nodeInput',
    state: new State({}),
    nodeInput,
    nodeName: 'n',
  });
}

/** Looks a descriptor up by name, failing the test when it is absent. */
function descriptorFor(schema: SchemaLike, name: string): ParameterDescriptor {
  const found = describeParameters(schema).find((d) => d.name === name);
  if (!found) {
    expect.fail(`no descriptor named "${name}"`);
  }
  return found;
}

describe('describeParameters', () => {
  it('reads name, required and default off a Zod v4 object schema', () => {
    const descriptors = describeParameters(
      z4.object({
        userName: z4.string(),
        greeting: z4.string().default('Hello'),
        note: z4.string().optional(),
      }),
    );

    expect(descriptors.map((d) => d.name)).toEqual([
      'userName',
      'greeting',
      'note',
    ]);
    const [userName, greeting, note] = descriptors;
    expect(userName).toMatchObject({required: true, hasDefault: false});
    expect(greeting).toMatchObject({hasDefault: true, defaultValue: 'Hello'});
    expect(note).toMatchObject({required: false, hasDefault: false});
  });

  it('reads a default off a Zod v3 object schema, which omits it from required', () => {
    const greeting = descriptorFor(
      z3.object({greeting: z3.string().default('Hi')}),
      'greeting',
    );

    // Zod v3 leaves a defaulted field out of `required`; Zod v4 lists it. The
    // descriptor carries the default either way, so binding does not depend on
    // which serializer wrote the document.
    expect(greeting.required).toBe(false);
    expect(greeting).toMatchObject({hasDefault: true, defaultValue: 'Hi'});
  });

  it('marks a string parameter, and a union holding a string, as expecting a string', () => {
    const schema = z4.object({
      text: z4.string(),
      count: z4.number(),
      either: z4.union([z4.string(), z4.number()]),
      nullableText: z4.string().nullable(),
    });

    expect(descriptorFor(schema, 'text').expectsString).toBe(true);
    expect(descriptorFor(schema, 'count').expectsString).toBe(false);
    expect(descriptorFor(schema, 'either').expectsString).toBe(true);
    expect(descriptorFor(schema, 'nullableText').expectsString).toBe(true);
  });

  it('detects a string in a Zod v3 union, which renders as a type array', () => {
    const either = descriptorFor(
      z3.object({either: z3.union([z3.string(), z3.number()])}),
      'either',
    );

    expect(either.expectsString).toBe(true);
  });

  it('returns no descriptors for a schema that declares no properties', () => {
    expect(describeParameters(z4.string())).toEqual([]);
  });

  it('leaves a genai Schema parameter unvalidated when it has no Zod equivalent', () => {
    // A pattern Zod cannot compile — the kind of thing that arrives on a tool
    // declaration off the wire — leaves that one field unchecked.
    const schema: Schema = {
      type: Type.OBJECT,
      properties: {tricky: {type: Type.STRING, pattern: '([unclosed'}},
    };

    expect(descriptorFor(schema, 'tricky').validate).toBeUndefined();
  });

  it('describes a genai Schema from its required list and validates its fields', () => {
    const schema: Schema = {
      type: Type.OBJECT,
      properties: {
        city: {type: Type.STRING},
        days: {type: Type.INTEGER},
      },
      required: ['city'],
    };

    const city = descriptorFor(schema, 'city');
    const days = descriptorFor(schema, 'days');

    expect(city).toMatchObject({required: true, expectsString: true});
    expect(days).toMatchObject({required: false, expectsString: false});
    expect(city.validate?.('Paris')).toBe('Paris');
    expect(() => days.validate?.('not a number')).toThrow();
  });

  it('keeps a Zod field as its own validator, so coercion survives', () => {
    // Rendering the field as JSON Schema and compiling it back would erase the
    // coercion: `z.coerce.number()` round-trips to a bare `{type: 'number'}`.
    const coerced = descriptorFor(z4.object({n: z4.coerce.number()}), 'n');
    const coercedV3 = descriptorFor(z3.object({n: z3.coerce.number()}), 'n');

    expect(coerced.validate?.('42')).toBe(42);
    expect(coercedV3.validate?.('42')).toBe(42);
  });

  it('keeps a custom refinement, which JSON Schema cannot carry', () => {
    const refined = descriptorFor(
      z4.object({word: z4.string().refine((s) => s.length > 2)}),
      'word',
    );

    expect(refined.validate?.('abc')).toBe('abc');
    expect(() => refined.validate?.('a')).toThrow();
  });

  it.each([
    {id: 'date', schema: z4.object({v: z4.date()})},
    {id: 'instanceof', schema: z4.object({v: z4.instanceof(Date)})},
    {
      id: 'transform',
      schema: z4.object({v: z4.string().transform((s) => s.length)}),
    },
  ])('describes a field JSON Schema cannot express ($id)', ({schema}) => {
    // Rendering the whole object as JSON Schema throws for each of these, which
    // used to abort node construction and lose every other parameter with it.
    const descriptors = describeParameters(schema);

    expect(descriptors.map((d) => d.name)).toEqual(['v']);
    expect(descriptors[0]).toMatchObject({
      required: true,
      hasDefault: false,
      expectsString: false,
    });
  });

  it('validates a field JSON Schema cannot express', () => {
    const when = new Date('2026-01-01T00:00:00Z');
    const dated = descriptorFor(z4.object({v: z4.date()}), 'v');
    const transformed = descriptorFor(
      z4.object({v: z4.string().transform((s) => s.length)}),
      'v',
    );

    expect(dated.validate?.(when)).toBe(when);
    expect(() => dated.validate?.('not a date')).toThrow();
    expect(transformed.validate?.('abcd')).toBe(4);
  });

  it('treats a field with an async refinement as required', () => {
    // A synchronous probe of an async refinement throws. Reporting the field as
    // required matches what binding a value to it would find.
    const asyncField = z4
      .string()
      .optional()
      .refine(async (v) => v !== 'no');

    expect(descriptorFor(z4.object({v: asyncField}), 'v')).toMatchObject({
      required: true,
      hasDefault: false,
    });
  });

  it('describes the other parameters of a schema holding an inexpressible field', () => {
    const descriptors = describeParameters(
      z4.object({
        name: z4.string(),
        when: z4.date(),
        count: z4.number().default(3),
      }),
    );

    expect(descriptors.map((d) => d.name)).toEqual(['name', 'when', 'count']);
    expect(descriptors[0].expectsString).toBe(true);
    expect(descriptors[2]).toMatchObject({hasDefault: true, defaultValue: 3});
  });
});

describe('bindParameters from state', () => {
  it('reads each declared parameter from state', () => {
    const descriptors = describeParameters(
      z4.object({userName: z4.string(), greeting: z4.string()}),
    );

    expect(
      bindFromState(descriptors, {userName: 'Ada', greeting: 'Hello'}),
    ).toEqual({userName: 'Ada', greeting: 'Hello'});
  });

  it('applies a declared default when state holds no value', () => {
    const descriptors = describeParameters(
      z4.object({userName: z4.string(), greeting: z4.string().default('Hi')}),
    );

    expect(bindFromState(descriptors, {userName: 'Ada'})).toEqual({
      userName: 'Ada',
      greeting: 'Hi',
    });
  });

  it('throws when a required parameter has no value and no default', () => {
    const descriptors = describeParameters(z4.object({userName: z4.string()}));

    expect(() => bindFromState(descriptors)).toThrow(
      'Missing value for parameter "userName" of function "n". It was not ' +
        'found in state and has no default value.',
    );
  });

  it('leaves an optional parameter with no default unbound', () => {
    const descriptors = describeParameters(
      z4.object({note: z4.string().optional()}),
    );

    expect(bindFromState(descriptors)).toEqual({});
  });

  it('hands the raw node input to the parameter named nodeInput', () => {
    const descriptors = describeParameters(
      z4.object({nodeInput: z4.string(), userName: z4.string()}),
    );

    expect(bindFromState(descriptors, {userName: 'Ada'}, 'upstream')).toEqual({
      nodeInput: 'upstream',
      userName: 'Ada',
    });
  });

  it('leaves an optional nodeInput parameter unbound when there is no node input', () => {
    const descriptors = describeParameters(
      z4.object({nodeInput: z4.object({text: z4.string()}).optional()}),
    );

    // An absent node input counts as absent, so it is not validated as
    // `undefined` against the parameter's own schema.
    expect(bindFromState(descriptors, {}, undefined)).toEqual({});
  });

  it('throws when a required nodeInput parameter has no node input', () => {
    const descriptors = describeParameters(z4.object({nodeInput: z4.string()}));

    expect(() => bindFromState(descriptors, {}, undefined)).toThrow(
      'Missing value for parameter "nodeInput"',
    );
  });

  it('converts a Content into text for a parameter that expects a string', () => {
    const descriptors = describeParameters(z4.object({nodeInput: z4.string()}));

    expect(
      bindFromState(descriptors, {}, {role: 'user', parts: [{text: 'hi'}]}),
    ).toEqual({nodeInput: 'hi'});
  });

  it('rejects a state value that does not match its parameter schema', () => {
    const descriptors = describeParameters(z4.object({count: z4.number()}));

    expect(() => bindFromState(descriptors, {count: 'not a number'})).toThrow(
      /^Invalid value for parameter "count" of function "n": /,
    );
  });

  it('carries the validation failure as the error cause', () => {
    const descriptors = describeParameters(z4.object({count: z4.number()}));

    try {
      bindFromState(descriptors, {count: 'not a number'});
      expect.fail('bindParameters should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(Error);
      expect((e as Error).cause).toBeInstanceOf(Error);
    }
  });

  it('passes a value through unchecked when its parameter has no validator', () => {
    const descriptors: ParameterDescriptor[] = [
      {name: 'free', required: true, hasDefault: false, expectsString: false},
    ];

    expect(bindFromState(descriptors, {free: {anything: true}})).toEqual({
      free: {anything: true},
    });
  });
});

describe('bindParameters from node input', () => {
  it('reads each declared parameter from the upstream output object', () => {
    const descriptors = describeParameters(
      z4.object({x: z4.number(), y: z4.number()}),
    );

    expect(bindFromNodeInput(descriptors, {x: 3, y: 4})).toEqual({x: 3, y: 4});
  });

  it('applies a declared default for a key the upstream output omits', () => {
    const descriptors = describeParameters(
      z4.object({x: z4.number(), y: z4.number().default(10)}),
    );

    expect(bindFromNodeInput(descriptors, {x: 5})).toEqual({x: 5, y: 10});
  });

  it('names nodeInput as the source in the missing-value error', () => {
    const descriptors = describeParameters(
      z4.object({x: z4.number(), y: z4.number()}),
    );

    expect(() => bindFromNodeInput(descriptors, {x: 5})).toThrow(
      'Missing value for parameter "y" of function "n". It was not found in ' +
        'nodeInput and has no default value.',
    );
  });

  it('reads a non-object node input as an empty source', () => {
    const descriptors = describeParameters(
      z4.object({x: z4.number().default(1)}),
    );

    // Python's `source = {}` fallback: every parameter then falls to its
    // default or raises.
    expect(bindFromNodeInput(descriptors, 42)).toEqual({x: 1});
    expect(bindFromNodeInput(descriptors, [1, 2])).toEqual({x: 1});
    expect(bindFromNodeInput(descriptors, null)).toEqual({x: 1});
  });

  it('does not treat a parameter named nodeInput specially', () => {
    const descriptors = describeParameters(z4.object({nodeInput: z4.string()}));

    expect(bindFromNodeInput(descriptors, {nodeInput: 'inner'})).toEqual({
      nodeInput: 'inner',
    });
  });
});

describe('contentToString', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('joins every text part', () => {
    const text = contentToString(
      {role: 'user', parts: [{text: 'Hello '}, {text: 'World'}]},
      'n',
      'p',
    );

    expect(text).toBe('Hello World');
  });

  it('returns an empty string for a Content with no parts', () => {
    expect(contentToString({role: 'user'}, 'n', 'p')).toBe('');
  });

  it('warns once and drops the non-text parts', () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});

    const text = contentToString(
      {
        role: 'user',
        parts: [
          {text: 'Hello'},
          {inlineData: {data: 'aW1n', mimeType: 'image/png'}},
          {fileData: {fileUri: 'gs://b/o', mimeType: 'image/png'}},
        ],
      },
      'reader',
      'prompt',
    );

    expect(text).toBe('Hello');
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain('non-text parts');
  });

  it('returns an empty string when every part is non-text', () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});

    const text = contentToString(
      {
        role: 'user',
        parts: [
          {executableCode: {code: 'print(1)', language: Language.PYTHON}},
        ],
      },
      'n',
      'p',
    );

    expect(text).toBe('');
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('does not warn for a part that carries neither text nor data', () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});

    expect(contentToString({role: 'user', parts: [{}]}, 'n', 'p')).toBe('');
    expect(warn).not.toHaveBeenCalled();
  });
});

describe('parameterFieldSchema', () => {
  it('returns a declared property of a Zod v4 object schema', () => {
    const inner = z4.string();

    expect(
      parameterFieldSchema(z4.object({nodeInput: inner}), 'nodeInput'),
    ).toBe(inner);
  });

  it('returns a declared property of a Zod v3 object schema', () => {
    const inner = z3.number();

    expect(
      parameterFieldSchema(z3.object({nodeInput: inner}), 'nodeInput'),
    ).toBe(inner);
  });

  it('returns a declared property of a genai Schema', () => {
    const schema: Schema = {
      type: Type.OBJECT,
      properties: {nodeInput: {type: Type.STRING}},
    };

    expect(parameterFieldSchema(schema, 'nodeInput')).toEqual({
      type: Type.STRING,
    });
  });

  it('returns undefined when the schema declares no such property', () => {
    expect(
      parameterFieldSchema(z4.object({other: z4.string()}), 'nodeInput'),
    ).toBeUndefined();
    expect(
      parameterFieldSchema({type: Type.OBJECT}, 'nodeInput'),
    ).toBeUndefined();
  });

  it('returns undefined for a schema that is not an object schema', () => {
    expect(parameterFieldSchema(z4.string(), 'nodeInput')).toBeUndefined();
  });
});
