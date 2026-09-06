/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/** Covers `_function_tool_declarations.ts`, the raw JSON Schema builder. */

import {Type} from '@google/genai';
import {afterEach, describe, expect, it, vi} from 'vitest';
import {z as z3} from 'zod/v3';
import {z} from 'zod/v4';

import {
  buildFunctionDeclarationWithJsonSchema,
  cleanDescription,
  unwrapReturnTypeName,
} from '../../src/tools/_function_tool_declarations.js';
import {logger} from '../../src/utils/logger.js';
import {GoogleLLMVariant} from '../../src/utils/variant_utils.js';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('buildFunctionDeclarationWithJsonSchema name and description', () => {
  it('throws when the name is empty', () => {
    expect(() =>
      buildFunctionDeclarationWithJsonSchema({name: ''}),
    ).toThrowError('Function declaration name cannot be empty.');
  });

  it('dedents and trims a multi-line description', () => {
    const declaration = buildFunctionDeclarationWithJsonSchema({
      name: 'lookup',
      description: `Look a city up.

        Args:
          city: The city name.
      `,
    });

    expect(declaration.description).toBe(
      'Look a city up.\n\nArgs:\n  city: The city name.',
    );
  });

  it('omits the description key when none is given', () => {
    const declaration = buildFunctionDeclarationWithJsonSchema({name: 'ping'});

    expect('description' in declaration).toBe(false);
  });
});

describe('buildFunctionDeclarationWithJsonSchema parameters', () => {
  it('omits parametersJsonSchema for a parameterless tool', () => {
    const declaration = buildFunctionDeclarationWithJsonSchema({name: 'ping'});

    expect('parametersJsonSchema' in declaration).toBe(false);
  });

  it('omits parametersJsonSchema when every property is ignored', () => {
    const declaration = buildFunctionDeclarationWithJsonSchema({
      name: 'onlyContext',
      parameters: z.object({toolContext: z.unknown()}),
    });

    expect('parametersJsonSchema' in declaration).toBe(false);
  });

  it('keeps a default and leaves the property out of required', () => {
    const declaration = buildFunctionDeclarationWithJsonSchema({
      name: 'greet',
      parameters: z.object({name: z.string(), count: z.number().default(3)}),
    });

    expect(declaration.parametersJsonSchema).toEqual({
      type: 'object',
      properties: {
        name: {type: 'string'},
        count: {type: 'number', default: 3},
      },
      required: ['name'],
    });
  });

  it('drops the context parameters and the ignored ones', () => {
    const declaration = buildFunctionDeclarationWithJsonSchema({
      name: 'lookup',
      parameters: z.object({
        query: z.string(),
        toolContext: z.unknown(),
        tool_context: z.unknown(),
        secret: z.string(),
      }),
      ignoreParams: ['secret'],
    });

    const parameters = declaration.parametersJsonSchema as Record<
      string,
      unknown
    >;
    expect(Object.keys(parameters['properties'] as object)).toEqual(['query']);
    expect(parameters['required']).toEqual(['query']);
  });

  it('omits parametersJsonSchema when the document declares no properties', () => {
    const declaration = buildFunctionDeclarationWithJsonSchema({
      name: 'ping',
      parameters: {type: Type.STRING},
    });

    expect('parametersJsonSchema' in declaration).toBe(false);
  });

  it('reads a Zod v3 object', () => {
    const declaration = buildFunctionDeclarationWithJsonSchema({
      name: 'greet',
      parameters: z3.object({name: z3.string()}),
    });

    const parameters = declaration.parametersJsonSchema as Record<
      string,
      unknown
    >;
    expect(parameters['properties']).toEqual({name: {type: 'string'}});
    expect('$schema' in parameters).toBe(false);
  });

  it('flattens a nullable property for VERTEX_AI only', () => {
    const parameters = z.object({nickname: z.string().nullable()});

    const vertex = buildFunctionDeclarationWithJsonSchema({
      name: 'greet',
      parameters,
      variant: GoogleLLMVariant.VERTEX_AI,
    }).parametersJsonSchema as Record<string, unknown>;
    const vertexProperty = (vertex['properties'] as Record<string, unknown>)[
      'nickname'
    ];
    expect(vertexProperty).toEqual({
      type: 'string',
      nullable: true,
    });

    const gemini = buildFunctionDeclarationWithJsonSchema({
      name: 'greet',
      parameters,
      variant: GoogleLLMVariant.GEMINI_API,
    }).parametersJsonSchema as Record<string, unknown>;
    const geminiProperty = (gemini['properties'] as Record<string, unknown>)[
      'nickname'
    ];
    expect(geminiProperty).toEqual({
      anyOf: [{type: 'string'}, {type: 'null'}],
    });
  });
});

describe('buildFunctionDeclarationWithJsonSchema response', () => {
  it('builds the response from a return schema', () => {
    const declaration = buildFunctionDeclarationWithJsonSchema({
      name: 'lookup',
      returnSchema: z.object({city: z.string()}),
    });

    expect(declaration.responseJsonSchema).toEqual({
      type: 'object',
      properties: {city: {type: 'string'}},
      required: ['city'],
    });
  });

  it('flattens a nullable return schema for VERTEX_AI', () => {
    const declaration = buildFunctionDeclarationWithJsonSchema({
      name: 'lookup',
      returnSchema: z.object({city: z.string().nullable()}),
      variant: GoogleLLMVariant.VERTEX_AI,
    });

    const response = declaration.responseJsonSchema as Record<string, unknown>;
    expect((response['properties'] as Record<string, unknown>)['city']).toEqual(
      {type: 'string', nullable: true},
    );
  });

  it('builds the response from a return type name', () => {
    expect(
      buildFunctionDeclarationWithJsonSchema({
        name: 'lookup',
        returnType: 'str',
      }).responseJsonSchema,
    ).toEqual({type: 'string'});
    expect(
      buildFunctionDeclarationWithJsonSchema({
        name: 'lookup',
        returnType: 'None',
      }).responseJsonSchema,
    ).toEqual({type: 'null'});
    expect(
      buildFunctionDeclarationWithJsonSchema({
        name: 'lookup',
        returnType: 'SomeClass',
      }).responseJsonSchema,
    ).toEqual({});
  });

  it('unwraps a streaming return type name', () => {
    expect(
      buildFunctionDeclarationWithJsonSchema({
        name: 'streamLines',
        returnType: 'AsyncGenerator<string, void>',
      }).responseJsonSchema,
    ).toEqual({type: 'string'});
  });

  it('omits responseJsonSchema when the tool declares no return value', () => {
    const declaration = buildFunctionDeclarationWithJsonSchema({name: 'ping'});

    expect('responseJsonSchema' in declaration).toBe(false);
  });

  it('warns once and omits the response when the return schema fails', () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});

    const declaration = buildFunctionDeclarationWithJsonSchema({
      name: 'schedule',
      parameters: z.object({label: z.string()}),
      returnSchema: z.date(),
    });

    expect('responseJsonSchema' in declaration).toBe(false);
    expect(declaration.parametersJsonSchema).toBeDefined();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain('schedule');
  });
});

describe('unwrapReturnTypeName', () => {
  it('takes the yield type of a streaming wrapper', () => {
    expect(unwrapReturnTypeName('AsyncGenerator<string, void>')).toBe('string');
    expect(unwrapReturnTypeName('Generator[int, None, None]')).toBe('int');
    expect(unwrapReturnTypeName('Promise<string>')).toBe('string');
    expect(unwrapReturnTypeName('AsyncIterable<Iterator<int>>')).toBe('int');
  });

  it('drops a remaining argument list', () => {
    expect(unwrapReturnTypeName('AsyncGenerator[Dict[str, str], None]')).toBe(
      'Dict',
    );
    expect(unwrapReturnTypeName('List<string>')).toBe('List');
  });

  it('leaves a plain name alone', () => {
    expect(unwrapReturnTypeName('str')).toBe('str');
    expect(unwrapReturnTypeName(' None ')).toBe('None');
    expect(unwrapReturnTypeName('AsyncGenerator')).toBe('AsyncGenerator');
  });

  it('returns a malformed argument list unchanged', () => {
    expect(unwrapReturnTypeName('AsyncGenerator<')).toBe('AsyncGenerator<');
    expect(unwrapReturnTypeName('<string>')).toBe('<string>');
  });

  it('stops unwrapping a pathologically nested name', () => {
    const nested = `${'Promise<'.repeat(12)}str${'>'.repeat(12)}`;

    expect(unwrapReturnTypeName(nested)).toBe(
      `${'Promise<'.repeat(4)}str${'>'.repeat(4)}`,
    );
  });
});

describe('cleanDescription', () => {
  it('removes the common indent of the lines after the first', () => {
    expect(cleanDescription('  first\n    second\n    third')).toBe(
      'first\nsecond\nthird',
    );
  });

  it('removes leading and trailing blank lines', () => {
    expect(cleanDescription('\n\n  body\n\n')).toBe('body');
  });

  it('leaves a single-line description alone', () => {
    expect(cleanDescription('Look a city up.')).toBe('Look a city up.');
  });

  it('returns an empty string for a blank description', () => {
    expect(cleanDescription('   \n  \n')).toBe('');
  });
});

describe('buildFunctionDeclarationWithJsonSchema genai Schema input', () => {
  it('renders a genai Schema as a JSON Schema document', () => {
    const declaration = buildFunctionDeclarationWithJsonSchema({
      name: 'greet',
      parameters: {
        type: Type.OBJECT,
        properties: {
          name: {type: Type.STRING},
          scores: {
            type: Type.ARRAY,
            items: {type: Type.INTEGER},
            maxItems: '5',
          },
        },
        required: ['name'],
      },
    });

    expect(declaration.parametersJsonSchema).toEqual({
      type: 'object',
      properties: {
        name: {type: 'string'},
        scores: {type: 'array', items: {type: 'integer'}, maxItems: 5},
      },
      required: ['name'],
    });
  });
});
