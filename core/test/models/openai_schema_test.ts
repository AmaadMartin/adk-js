/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {describe, expect, it} from 'vitest';

import {
  enforceStrictOpenAiSchema,
  isJsonSchemaObject,
  lowercaseSchemaTypes,
} from '../../src/models/openai_schema.js';

describe('isJsonSchemaObject', () => {
  it('accepts an object and rejects everything else', () => {
    expect(isJsonSchemaObject({})).toBe(true);
    expect(isJsonSchemaObject([])).toBe(false);
    expect(isJsonSchemaObject(null)).toBe(false);
    expect(isJsonSchemaObject('object')).toBe(false);
    expect(isJsonSchemaObject(undefined)).toBe(false);
  });
});

describe('lowercaseSchemaTypes', () => {
  it('recurses through every keyword that holds subschemas', () => {
    const schema = {
      type: 'OBJECT',
      $defs: {Node: {type: 'STRING'}},
      properties: {a: {type: 'NUMBER'}},
      patternProperties: {'^x': {type: 'BOOLEAN'}},
      items: {type: 'ARRAY'},
      not: {type: 'NULL'},
      anyOf: [{type: 'STRING'}, {type: 'INTEGER'}],
      prefixItems: [{type: 'BOOLEAN'}],
    };

    lowercaseSchemaTypes(schema);

    expect(schema).toEqual({
      type: 'object',
      $defs: {Node: {type: 'string'}},
      properties: {a: {type: 'number'}},
      patternProperties: {'^x': {type: 'boolean'}},
      items: {type: 'array'},
      not: {type: 'null'},
      anyOf: [{type: 'string'}, {type: 'integer'}],
      prefixItems: [{type: 'boolean'}],
    });
  });

  it('descends into a list of subschemas', () => {
    const schemas = [{type: 'STRING'}, {type: 'INTEGER'}];

    lowercaseSchemaTypes(schemas);

    expect(schemas).toEqual([{type: 'string'}, {type: 'integer'}]);
  });

  it('leaves a non-schema value alone', () => {
    const schema = {
      type: true,
      properties: 'not a map',
      items: 'not a schema',
      anyOf: 'not a list',
    };

    lowercaseSchemaTypes(schema);
    lowercaseSchemaTypes('string');
    lowercaseSchemaTypes(undefined);

    expect(schema).toEqual({
      type: true,
      properties: 'not a map',
      items: 'not a schema',
      anyOf: 'not a list',
    });
  });
});

describe('enforceStrictOpenAiSchema', () => {
  it('forbids extra properties and requires every property, sorted', () => {
    const schema = {
      type: 'object',
      properties: {beta: {type: 'string'}, alpha: {type: 'string'}},
    };

    enforceStrictOpenAiSchema(schema);

    expect(schema).toEqual({
      type: 'object',
      properties: {beta: {type: 'string'}, alpha: {type: 'string'}},
      additionalProperties: false,
      required: ['alpha', 'beta'],
    });
  });

  it('strips every sibling keyword of a $ref', () => {
    const schema = {
      $ref: '#/$defs/Node',
      description: 'dropped',
      title: 'dropped',
    };

    enforceStrictOpenAiSchema(schema);

    expect(schema).toEqual({$ref: '#/$defs/Node'});
  });

  it('recurses through $defs, properties, combinators and items', () => {
    const schema = {
      type: 'object',
      $defs: {
        Node: {type: 'object', properties: {b: {type: 'string'}}},
      },
      properties: {
        nested: {type: 'object', properties: {z: {type: 'string'}}},
        choice: {
          anyOf: [{type: 'object', properties: {y: {type: 'string'}}}],
        },
        every: {
          allOf: [{type: 'object', properties: {w: {type: 'string'}}}],
        },
        exactly: {
          oneOf: [{type: 'object', properties: {v: {type: 'string'}}}],
        },
        list: {
          type: 'array',
          items: {type: 'object', properties: {u: {type: 'string'}}},
        },
      },
    };

    enforceStrictOpenAiSchema(schema);

    expect(schema.$defs.Node).toMatchObject({
      additionalProperties: false,
      required: ['b'],
    });
    expect(schema.properties.nested).toMatchObject({required: ['z']});
    expect(schema.properties.choice.anyOf[0]).toMatchObject({required: ['y']});
    expect(schema.properties.every.allOf[0]).toMatchObject({required: ['w']});
    expect(schema.properties.exactly.oneOf[0]).toMatchObject({required: ['v']});
    expect(schema.properties.list.items).toMatchObject({required: ['u']});
    expect(schema).toMatchObject({
      required: ['choice', 'every', 'exactly', 'list', 'nested'],
    });
  });

  it('leaves an object with no properties map alone', () => {
    const schema = {type: 'object'};

    enforceStrictOpenAiSchema(schema);

    expect(schema).toEqual({type: 'object'});
  });

  it('skips a subschema slot that does not hold a schema', () => {
    const schema = {
      type: 'string',
      $defs: 'not a map',
      properties: 'not a map',
      anyOf: 'not a list',
      items: 'not a schema',
    };

    enforceStrictOpenAiSchema(schema);

    expect(schema).toEqual({
      type: 'string',
      $defs: 'not a map',
      properties: 'not a map',
      anyOf: 'not a list',
      items: 'not a schema',
    });
  });

  it('skips a non-schema entry inside a subschema slot', () => {
    const schema = {
      $defs: {broken: 'not a schema'},
      properties: {broken: 'not a schema'},
      anyOf: ['not a schema'],
    };

    enforceStrictOpenAiSchema(schema);

    expect(schema).toEqual({
      $defs: {broken: 'not a schema'},
      properties: {broken: 'not a schema'},
      anyOf: ['not a schema'],
    });
  });
});
