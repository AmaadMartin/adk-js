/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {describe, expect, it} from 'vitest';
import {
  enforceStrictOpenAiSchema,
  isJsonObject,
  JsonObject,
} from '../../../src/models/openai/openai_schema.js';

describe('isJsonObject', () => {
  it('accepts a plain object', () => {
    expect(isJsonObject({a: 1})).toBe(true);
  });

  it('rejects an array, null and a primitive', () => {
    expect(isJsonObject([1, 2])).toBe(false);
    expect(isJsonObject(null)).toBe(false);
    expect(isJsonObject('text')).toBe(false);
  });
});

describe('enforceStrictOpenAiSchema', () => {
  it('requires every property and forbids additional ones', () => {
    const schema: JsonObject = {
      type: 'object',
      properties: {b: {type: 'string'}, a: {type: 'number'}},
    };

    enforceStrictOpenAiSchema(schema);

    expect(schema['additionalProperties']).toBe(false);
    expect(schema['required']).toEqual(['a', 'b']);
  });

  it('leaves an object without properties alone', () => {
    const schema: JsonObject = {type: 'object'};

    enforceStrictOpenAiSchema(schema);

    expect(schema).toEqual({type: 'object'});
  });

  it('leaves a non-object node alone', () => {
    const schema: JsonObject = {type: 'string', properties: {a: {}}};

    enforceStrictOpenAiSchema(schema);

    expect(schema['additionalProperties']).toBeUndefined();
  });

  it('drops the siblings of a $ref', () => {
    const schema: JsonObject = {
      $ref: '#/$defs/Child',
      description: 'dropped',
      type: 'object',
    };

    enforceStrictOpenAiSchema(schema);

    expect(schema).toEqual({$ref: '#/$defs/Child'});
  });

  it('recurses into $defs, properties, anyOf and items', () => {
    const schema: JsonObject = {
      type: 'object',
      properties: {
        child: {$ref: '#/$defs/Child', title: 'dropped'},
        list: {
          type: 'array',
          items: {type: 'object', properties: {z: {type: 'string'}}},
        },
        choice: {
          anyOf: [
            {type: 'object', properties: {y: {type: 'string'}}},
            {type: 'null'},
          ],
        },
      },
      $defs: {
        Child: {type: 'object', properties: {name: {type: 'string'}}},
      },
    };

    enforceStrictOpenAiSchema(schema);

    expect(schema['required']).toEqual(['child', 'choice', 'list']);
    const properties = schema['properties'] as JsonObject;
    expect(properties['child']).toEqual({$ref: '#/$defs/Child'});
    const defs = schema['$defs'] as JsonObject;
    expect(defs['Child']).toEqual({
      type: 'object',
      properties: {name: {type: 'string'}},
      additionalProperties: false,
      required: ['name'],
    });
    const list = properties['list'] as JsonObject;
    expect(list['items']).toEqual({
      type: 'object',
      properties: {z: {type: 'string'}},
      additionalProperties: false,
      required: ['z'],
    });
    const choice = properties['choice'] as JsonObject;
    const branches = choice['anyOf'] as JsonObject[];
    expect(branches[0]['required']).toEqual(['y']);
    expect(branches[1]).toEqual({type: 'null'});
  });

  it('recurses into oneOf and allOf branches', () => {
    const schema: JsonObject = {
      oneOf: [{type: 'object', properties: {a: {}}}],
      allOf: [{type: 'object', properties: {b: {}}}],
    };

    enforceStrictOpenAiSchema(schema);

    expect((schema['oneOf'] as JsonObject[])[0]['required']).toEqual(['a']);
    expect((schema['allOf'] as JsonObject[])[0]['required']).toEqual(['b']);
  });

  it('ignores keywords whose value is not a sub-schema', () => {
    const schema: JsonObject = {
      type: 'array',
      items: 'not-a-schema',
      $defs: 'not-a-map',
      anyOf: 'not-a-list',
    };

    enforceStrictOpenAiSchema(schema);

    expect(schema).toEqual({
      type: 'array',
      items: 'not-a-schema',
      $defs: 'not-a-map',
      anyOf: 'not-a-list',
    });
  });
});
