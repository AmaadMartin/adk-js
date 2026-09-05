/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Language, Schema, Type} from '@google/genai';
import {describe, expect, it, vi} from 'vitest';
import {z as z3} from 'zod/v3';
import {z as z4} from 'zod/v4';
import {State} from '../../src/sessions/state.js';
import {logger} from '../../src/utils/logger.js';
import {
  bindParameters,
  contentToString,
  describeParameters,
  parameterFieldSchema,
} from '../../src/workflow/utils/parameter_binding.js';

/** Looks a descriptor up by name, failing the test when it is missing. */
function descriptorFor(
  descriptors: ReturnType<typeof describeParameters>,
  name: string,
) {
  const descriptor = descriptors.find((d) => d.name === name);
  if (!descriptor) {
    expect.fail(`no descriptor for "${name}"`);
  }
  return descriptor;
}

describe('describeParameters', () => {
  it('resolves required, default and string-ness from a Zod v4 object', () => {
    const descriptors = describeParameters(
      z4.object({
        userName: z4.string(),
        greeting: z4.string().default('Hello'),
        retries: z4.number().optional(),
        maybeText: z4.string().nullable(),
      }),
    );

    expect(descriptors.map((d) => d.name)).toEqual([
      'userName',
      'greeting',
      'retries',
      'maybeText',
    ]);
    expect(descriptorFor(descriptors, 'userName')).toMatchObject({
      required: true,
      hasDefault: false,
      expectsString: true,
    });
    expect(descriptorFor(descriptors, 'greeting')).toMatchObject({
      hasDefault: true,
      defaultValue: 'Hello',
    });
    expect(descriptorFor(descriptors, 'retries')).toMatchObject({
      required: false,
      hasDefault: false,
      expectsString: false,
    });
    // A nullable string renders as `anyOf: [string, null]`, still a string.
    expect(descriptorFor(descriptors, 'maybeText').expectsString).toBe(true);
  });

  it('resolves the same fields from a Zod v3 object', () => {
    const descriptors = describeParameters(
      z3.object({
        userName: z3.string(),
        greeting: z3.string().default('Hi'),
        count: z3.number(),
      }),
    );

    expect(descriptorFor(descriptors, 'userName').required).toBe(true);
    expect(descriptorFor(descriptors, 'greeting')).toMatchObject({
      hasDefault: true,
      defaultValue: 'Hi',
    });
    expect(descriptorFor(descriptors, 'count').expectsString).toBe(false);
    expect(descriptorFor(descriptors, 'count').validate?.(1)).toBe(1);
  });

  it('resolves fields from a genai Schema', () => {
    const schema: Schema = {
      type: Type.OBJECT,
      properties: {
        city: {type: Type.STRING},
        limit: {type: Type.INTEGER, default: 5},
        note: {type: Type.STRING, nullable: true},
      },
      required: ['city'],
    };
    const descriptors = describeParameters(schema);

    expect(descriptorFor(descriptors, 'city')).toMatchObject({
      required: true,
      expectsString: true,
    });
    // A nullable genai type renders as `type: ['string', 'null']`.
    expect(descriptorFor(descriptors, 'note').expectsString).toBe(true);
    expect(descriptorFor(descriptors, 'limit')).toMatchObject({
      required: false,
      hasDefault: true,
      defaultValue: 5,
    });
  });

  it('degrades a field with no Zod equivalent to unvalidated', () => {
    // A recursive schema has no finite inlining, so its field compiles to no
    // validator while its siblings keep theirs.
    const node: z3.ZodType<{child?: unknown}> = z3.lazy(() =>
      z3.object({child: node.optional()}),
    );
    const descriptors = describeParameters(
      z3.object({tree: node, label: z3.string()}),
    );

    expect(descriptorFor(descriptors, 'tree').validate).toBeUndefined();
    expect(descriptorFor(descriptors, 'label').validate).toBeDefined();
  });

  it('returns no descriptors for a schema that declares no properties', () => {
    expect(describeParameters(z4.string())).toEqual([]);
  });
});

describe('bindParameters', () => {
  const descriptors = describeParameters(
    z4.object({x: z4.number(), y: z4.number().default(10)}),
  );

  it('falls back to an empty source for a non-object node input', () => {
    // `y` still defaults; `x` is required and therefore unbindable.
    expect(() =>
      bindParameters({
        descriptors,
        binding: 'nodeInput',
        state: new State(),
        nodeInput: 'not-an-object',
        nodeName: 'add',
      }),
    ).toThrow('Missing value for parameter "x" of function "add"');
  });

  it('treats an array node input as an empty source', () => {
    expect(() =>
      bindParameters({
        descriptors,
        binding: 'nodeInput',
        state: new State(),
        nodeInput: [1, 2],
        nodeName: 'add',
      }),
    ).toThrow('It was not found in nodeInput and has no default value.');
  });

  it('leaves an optional parameter with no default unbound', () => {
    const optional = describeParameters(
      z4.object({note: z4.string().optional()}),
    );
    const args = bindParameters({
      descriptors: optional,
      binding: 'state',
      state: new State(),
      nodeInput: undefined,
      nodeName: 'n',
    });
    expect(args).toEqual({});
  });

  it('wraps a validation failure with the parameter and node name', () => {
    expect(() =>
      bindParameters({
        descriptors,
        binding: 'nodeInput',
        state: new State(),
        nodeInput: {x: 'nope'},
        nodeName: 'add',
      }),
    ).toThrow('Invalid value for parameter "x" of function "add"');
  });

  it('keeps the validation failure as the error cause', () => {
    try {
      bindParameters({
        descriptors,
        binding: 'nodeInput',
        state: new State(),
        nodeInput: {x: 'nope'},
        nodeName: 'add',
      });
      expect.fail('expected bindParameters to throw');
    } catch (e) {
      expect((e as Error).cause).toBeInstanceOf(Error);
    }
  });

  it('reads from state and names state in the missing-value error', () => {
    const state = new State({x: 1});
    expect(
      bindParameters({
        descriptors,
        binding: 'state',
        state,
        nodeInput: undefined,
        nodeName: 'add',
      }),
    ).toEqual({x: 1, y: 10});

    expect(() =>
      bindParameters({
        descriptors,
        binding: 'state',
        state: new State(),
        nodeInput: undefined,
        nodeName: 'add',
      }),
    ).toThrow('It was not found in state and has no default value.');
  });

  it('passes a value through when the parameter has no validator', () => {
    // A recursive schema has no finite inlining, so `tree` compiles to no
    // validator and its value reaches the handler unchecked.
    const tree: z3.ZodType<{child?: unknown}> = z3.lazy(() =>
      z3.object({child: tree.optional()}),
    );
    const args = bindParameters({
      descriptors: describeParameters(z3.object({tree})),
      binding: 'nodeInput',
      state: new State(),
      nodeInput: {tree: 'anything'},
      nodeName: 'n',
    });
    expect(args).toEqual({tree: 'anything'});
  });
});

describe('contentToString', () => {
  it('returns an empty string for a Content with no parts', () => {
    expect(contentToString({role: 'user', parts: []}, 'n', 'p')).toBe('');
    expect(contentToString({role: 'user'}, 'n', 'p')).toBe('');
  });

  it('joins text parts with no separator', () => {
    expect(
      contentToString(
        {role: 'user', parts: [{text: 'Hello'}, {text: ' world'}]},
        'n',
        'p',
      ),
    ).toBe('Hello world');
  });

  it('drops fileData and warns', () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    const text = contentToString(
      {
        role: 'user',
        parts: [
          {text: 'Hello'},
          {fileData: {fileUri: 'gs://bucket/a.png', mimeType: 'image/png'}},
        ],
      },
      'greet',
      'message',
    );
    expect(text).toBe('Hello');
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('non-text parts'),
    );
    warn.mockRestore();
  });

  it('drops executableCode and warns', () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    const text = contentToString(
      {
        role: 'user',
        parts: [
          {executableCode: {code: 'print(1)', language: Language.PYTHON}},
        ],
      },
      'greet',
      'message',
    );
    expect(text).toBe('');
    expect(warn).toHaveBeenCalledOnce();
    warn.mockRestore();
  });

  it('skips an unrecognised part without warning', () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    expect(
      contentToString(
        {role: 'user', parts: [{thought: true}, {text: 'ok'}]},
        'n',
        'p',
      ),
    ).toBe('ok');
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe('parameterFieldSchema', () => {
  it('returns a declared field of a Zod object', () => {
    const field = z4.object({id: z4.string()});
    expect(
      parameterFieldSchema(z4.object({nodeInput: field}), 'nodeInput'),
    ).toBe(field);
  });

  it('returns a declared field of a Zod v3 object', () => {
    const field = z3.object({id: z3.string()});
    expect(
      parameterFieldSchema(z3.object({nodeInput: field}), 'nodeInput'),
    ).toBe(field);
  });

  it('returns a declared property of a genai Schema', () => {
    const field: Schema = {type: Type.STRING};
    expect(
      parameterFieldSchema(
        {type: Type.OBJECT, properties: {nodeInput: field}},
        'nodeInput',
      ),
    ).toBe(field);
  });

  it('returns undefined when the schema declares no such field', () => {
    expect(
      parameterFieldSchema(z4.object({x: z4.number()}), 'nodeInput'),
    ).toBeUndefined();
    expect(
      parameterFieldSchema({type: Type.OBJECT}, 'nodeInput'),
    ).toBeUndefined();
  });
});
