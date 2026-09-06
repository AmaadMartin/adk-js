/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Declaration behaviour of the LangChain adapter, translated from adk-python
 * v0.2.0 `tests/unittests/tools/test_build_function_declaration.py`. Each
 * translated case names the Python case it comes from.
 *
 * Python reaches these shapes through
 * `_automatic_function_calling_util.build_function_declaration`, which
 * `LangchainTool._get_declaration()` calls with the wrapped tool's
 * `args_schema`. adk-js has no such helper, so the same shapes are asserted
 * through the adapter's public surface.
 */

import {Context, LangchainTool, LangchainToolLike} from '@google/adk';
import {FunctionDeclaration, Schema, Type} from '@google/genai';
import {describe, expect, it, vi} from 'vitest';
import {z} from 'zod/v4';

function fakeLangchainTool(
  overrides: Partial<LangchainToolLike> = {},
): LangchainToolLike {
  return {
    name: 'simple_function',
    description: 'A simple function.',
    invoke: async () => 'ok',
    ...overrides,
  };
}

function declarationFor(overrides: Partial<LangchainToolLike>) {
  return new LangchainTool({
    tool: fakeLangchainTool(overrides),
  })._getDeclaration();
}

function parametersOf(declaration: FunctionDeclaration): Schema {
  if (!declaration.parameters) {
    expect.fail(`declaration '${declaration.name}' declares no parameters`);
  }
  return declaration.parameters;
}

function propertyOf(schema: Schema, name: string): Schema {
  const property = schema.properties?.[name];
  if (!property) {
    expect.fail(`schema declares no '${name}' property`);
  }
  return property;
}

function itemsOf(schema: Schema): Schema {
  if (!schema.items) {
    expect.fail('schema declares no array items');
  }
  return schema.items;
}

describe('LangchainTool', () => {
  describe('_getDeclaration', () => {
    it('maps a string field (test_string_input)', () => {
      const declaration = declarationFor({
        schema: z.object({inputStr: z.string()}),
      });

      expect(declaration.name).toBe('simple_function');
      const parameters = parametersOf(declaration);
      expect(parameters.type).toBe(Type.OBJECT);
      expect(propertyOf(parameters, 'inputStr').type).toBe(Type.STRING);
    });

    it('maps an integer field (test_int_input)', () => {
      const declaration = declarationFor({
        schema: z.object({inputStr: z.int()}),
      });

      const parameters = parametersOf(declaration);
      expect(propertyOf(parameters, 'inputStr').type).toBe(Type.INTEGER);
    });

    it('maps a float field (test_float_input)', () => {
      const declaration = declarationFor({
        schema: z.object({inputStr: z.number()}),
      });

      const parameters = parametersOf(declaration);
      expect(propertyOf(parameters, 'inputStr').type).toBe(Type.NUMBER);
    });

    it('maps a boolean field (test_bool_input)', () => {
      const declaration = declarationFor({
        schema: z.object({inputStr: z.boolean()}),
      });

      const parameters = parametersOf(declaration);
      expect(propertyOf(parameters, 'inputStr').type).toBe(Type.BOOLEAN);
    });

    it('maps an array field (test_array_input)', () => {
      const declaration = declarationFor({
        schema: z.object({inputStr: z.array(z.string())}),
      });

      const parameters = parametersOf(declaration);
      expect(propertyOf(parameters, 'inputStr').type).toBe(Type.ARRAY);
    });

    it('maps a record field (test_dict_input)', () => {
      const declaration = declarationFor({
        schema: z.object({inputStr: z.record(z.string(), z.string())}),
      });

      const parameters = parametersOf(declaration);
      expect(propertyOf(parameters, 'inputStr').type).toBe(Type.OBJECT);
    });

    it('maps an object field (test_basemodel_input)', () => {
      const declaration = declarationFor({
        schema: z.object({input: z.object({inputStr: z.string()})}),
      });

      const parameters = parametersOf(declaration);
      const input = propertyOf(parameters, 'input');
      expect(input.type).toBe(Type.OBJECT);
      expect(propertyOf(input, 'inputStr').type).toBe(Type.STRING);
    });

    it('names the declaration after the wrapped tool (test_basemodel)', () => {
      const declaration = declarationFor({
        name: 'SimpleFunction',
        schema: z.object({inputStr: z.string()}),
        invoke: async () => 'ok',
      });

      expect(declaration.name).toBe('SimpleFunction');
      const parameters = parametersOf(declaration);
      expect(propertyOf(parameters, 'inputStr').type).toBe(Type.STRING);
    });

    it('maps a twice-nested object field (test_nested_basemodel_input)', () => {
      const declaration = declarationFor({
        schema: z.object({
          input: z.object({child: z.object({inputStr: z.string()})}),
        }),
      });

      const parameters = parametersOf(declaration);
      const input = propertyOf(parameters, 'input');
      expect(input.type).toBe(Type.OBJECT);
      const child = propertyOf(input, 'child');
      expect(child.type).toBe(Type.OBJECT);
      expect(propertyOf(child, 'inputStr').type).toBe(Type.STRING);
    });

    it('maps a nested object at the top level (test_basemodel_with_nested_basemodel)', () => {
      const declaration = declarationFor({
        schema: z.object({child: z.object({inputStr: z.string()})}),
      });

      const parameters = parametersOf(declaration);
      const child = propertyOf(parameters, 'child');
      expect(child.type).toBe(Type.OBJECT);
      expect(propertyOf(child, 'inputStr').type).toBe(Type.STRING);
    });

    it('maps the item type of each array field (test_list)', () => {
      const declaration = declarationFor({
        schema: z.object({
          inputStr: z.array(z.string()),
          inputDir: z.array(z.record(z.string(), z.string())),
        }),
      });

      const parameters = parametersOf(declaration);
      const inputStr = propertyOf(parameters, 'inputStr');
      expect(inputStr.type).toBe(Type.ARRAY);
      expect(itemsOf(inputStr).type).toBe(Type.STRING);
      const inputDir = propertyOf(parameters, 'inputDir');
      expect(inputDir.type).toBe(Type.ARRAY);
      expect(itemsOf(inputDir).type).toBe(Type.OBJECT);
    });

    it('maps an array of nested objects (test_basemodel_list)', () => {
      const declaration = declarationFor({
        schema: z.object({
          inputStr: z.array(
            z.object({child: z.object({inputStr: z.string()})}),
          ),
        }),
      });

      const parameters = parametersOf(declaration);
      const inputStr = propertyOf(parameters, 'inputStr');
      expect(inputStr.type).toBe(Type.ARRAY);
      const item = itemsOf(inputStr);
      expect(item.type).toBe(Type.OBJECT);
      const child = propertyOf(item, 'child');
      expect(child.type).toBe(Type.OBJECT);
      expect(propertyOf(child, 'inputStr').type).toBe(Type.STRING);
    });
  });

  // The two cases below support the translated set. Without them the adapter
  // could satisfy every case above and still be unable to run.
  it('runs the wrapped tool through its invoke method', async () => {
    const invoke = vi.fn(async (input: {x: number; y: number}) => {
      return input.x + input.y;
    });
    const tool = new LangchainTool({
      tool: fakeLangchainTool({
        schema: z.object({x: z.number(), y: z.number()}),
        invoke,
      }),
    });

    const result = await tool.runAsync({
      args: {x: 1, y: 3},
      toolContext: {} as Context,
    });

    expect(result).toBe(4);
    expect(invoke).toHaveBeenCalledWith({x: 1, y: 3});
  });

  it('rejects a tool that exposes neither invoke nor call', () => {
    const tool: LangchainToolLike = {
      name: 'not_a_langchain_tool',
      description: 'Has no entry point.',
    };

    // The control keeps the rejection meaningful: a constructor that throws
    // for every tool would otherwise satisfy the assertion below.
    expect(() => new LangchainTool({tool: fakeLangchainTool()})).not.toThrow();
    expect(() => new LangchainTool({tool})).toThrow();
  });
});
