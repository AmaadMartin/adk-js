/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {describe, expect, it} from 'vitest';

import {lowercaseSchemaTypes} from '../../src/utils/schema_utils.js';

describe('lowercaseSchemaTypes', () => {
  it('ignores a value that is not a schema', () => {
    expect(() => {
      lowercaseSchemaTypes('not-a-schema');
    }).not.toThrow();
  });

  it('leaves a non-string type alone', () => {
    const schema = {type: 7};
    lowercaseSchemaTypes(schema);
    expect(schema).toEqual({type: 7});
  });

  it('walks a list of schemas', () => {
    const schemas = [{type: 'STRING'}, {type: 'INTEGER'}];
    lowercaseSchemaTypes(schemas);
    expect(schemas).toEqual([{type: 'string'}, {type: 'integer'}]);
  });

  it('leaves a list-valued key holding a single schema alone', () => {
    const schema = {anyOf: {type: 'STRING'}};
    lowercaseSchemaTypes(schema);
    expect(schema).toEqual({anyOf: {type: 'STRING'}});
  });

  it('lowercases a map-valued key, a single-valued key and a list', () => {
    const schema = {
      type: 'OBJECT',
      properties: {query: {type: 'STRING'}},
      items: {type: 'NUMBER'},
      anyOf: [{type: 'BOOLEAN'}],
    };

    lowercaseSchemaTypes(schema);

    expect(schema).toEqual({
      type: 'object',
      properties: {query: {type: 'string'}},
      items: {type: 'number'},
      anyOf: [{type: 'boolean'}],
    });
  });
});
