/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Context, FunctionTool} from '@google/adk';
import {Schema, Type} from '@google/genai';
import {describe, expect, it} from 'vitest';
import {z as z3} from 'zod/v3';
import {z as z4} from 'zod/v4';

const emptyContext = {} as Context;

describe('FunctionTool signature-derived parameters', () => {
  it('derives the parameter names and the required set', () => {
    const forecast = new FunctionTool({
      name: 'forecast',
      description: 'Looks up a forecast.',
      execute: ({city, days = 3}) => `${city}/${days}`,
    });

    expect(forecast._getDeclaration().parameters).toEqual({
      type: Type.OBJECT,
      properties: {
        city: {type: Type.TYPE_UNSPECIFIED},
        days: {type: Type.TYPE_UNSPECIFIED},
      },
      required: ['city'],
    });
  });

  it('lists every parameter as required in declaration order', () => {
    const tool = new FunctionTool({
      name: 'book',
      description: 'Books a trip.',
      execute: ({origin, destination}) => `${origin}->${destination}`,
    });

    expect(tool._getDeclaration().parameters?.required).toEqual([
      'origin',
      'destination',
    ]);
  });

  it('omits required when every parameter has a default', () => {
    const tool = new FunctionTool({
      name: 'greet',
      description: 'Greets someone.',
      execute: ({name = 'world'}) => `hello ${name}`,
    });

    expect(tool._getDeclaration().parameters).toEqual({
      type: Type.OBJECT,
      properties: {name: {type: Type.TYPE_UNSPECIFIED}},
    });
    expect(tool._getDeclaration().parameters).not.toHaveProperty('required');
  });

  it('does not declare a rest element as a property', () => {
    const tool = new FunctionTool({
      name: 'collect',
      description: 'Collects extras.',
      execute: ({first, ...extras}) => [first, extras],
    });

    expect(tool._getDeclaration().parameters).toEqual({
      type: Type.OBJECT,
      properties: {first: {type: Type.TYPE_UNSPECIFIED}},
      required: ['first'],
    });
  });

  it('declares no parameters when the signature cannot be read', () => {
    const tool = new FunctionTool({
      name: 'echo',
      description: 'Echoes its input.',
      execute: (input) => input,
    });

    expect(tool._getDeclaration().parameters).toEqual({
      type: Type.OBJECT,
      properties: {},
    });
  });

  it('hands out a fresh declaration each call', () => {
    const tool = new FunctionTool({
      name: 'forecast',
      description: 'Looks up a forecast.',
      execute: ({city}) => city,
    });

    const first = tool._getDeclaration();
    const second = tool._getDeclaration();
    expect(first.parameters).toEqual(second.parameters);
    expect(first.parameters).not.toBe(second.parameters);

    first.parameters!.properties!['injected'] = {type: Type.STRING};
    first.parameters!.required!.push('injected');

    expect(tool._getDeclaration().parameters).toEqual({
      type: Type.OBJECT,
      properties: {city: {type: Type.TYPE_UNSPECIFIED}},
      required: ['city'],
    });
  });

  it('forwards the raw arguments to execute without filtering them', async () => {
    const seen: unknown[] = [];
    const tool = new FunctionTool({
      name: 'forecast',
      description: 'Looks up a forecast.',
      execute: (input) => {
        seen.push(input);
        return input;
      },
    });

    const args = {city: 'Paris', unexpected: 1};
    const result = await tool.runAsync({args, toolContext: emptyContext});

    expect(result).toEqual(args);
    expect(seen).toEqual([args]);
  });

  describe('declared parameters win over the signature', () => {
    it('keeps a zod v3 schema', () => {
      const tool = new FunctionTool({
        name: 'add',
        description: 'Adds two numbers.',
        parameters: z3.object({a: z3.number(), b: z3.number()}),
        execute: ({a, b}) => a + b,
      });

      expect(tool._getDeclaration().parameters).toEqual({
        type: Type.OBJECT,
        properties: {a: {type: Type.NUMBER}, b: {type: Type.NUMBER}},
        required: ['a', 'b'],
      });
    });

    it('keeps a zod v4 schema', () => {
      const tool = new FunctionTool({
        name: 'add',
        description: 'Adds two numbers.',
        parameters: z4.object({a: z4.number(), b: z4.number()}),
        execute: ({a, b}) => a + b,
      });

      expect(tool._getDeclaration().parameters).toEqual({
        type: Type.OBJECT,
        properties: {a: {type: Type.NUMBER}, b: {type: Type.NUMBER}},
        required: ['a', 'b'],
      });
    });

    it('keeps a raw genai schema', () => {
      const parameters: Schema = {
        type: Type.OBJECT,
        properties: {word: {type: Type.STRING}},
      };
      const tool = new FunctionTool({
        name: 'shout',
        description: 'Shouts a word.',
        parameters,
        execute: (input) => input,
      });

      // Equal, not identical: `_getDeclaration` hands out a copy so a caller
      // cannot reach the schema it supplied. See the `_getDeclaration copies`
      // tests in function_tool_test.ts.
      expect(tool._getDeclaration().parameters).toEqual(parameters);
    });
  });
});
