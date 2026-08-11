/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {describe, expect, it} from 'vitest';
import {validateAgainstJsonSchema} from '../../src/utils/json_schema_validator.js';

describe('validateAgainstJsonSchema — unrecognised schemas pass through', () => {
  it('returns the value for a null, undefined or non-object schema', () => {
    expect(validateAgainstJsonSchema('hello', null)).toBe('hello');
    expect(validateAgainstJsonSchema('hello', undefined)).toBe('hello');
    expect(validateAgainstJsonSchema('hello', 'integer')).toBe('hello');
  });

  it('returns the value for a schema with no type or an unknown type', () => {
    expect(validateAgainstJsonSchema(42, {})).toBe(42);
    expect(validateAgainstJsonSchema(42, {type: 'wat'})).toBe(42);
  });

  it('returns the value for a type array and for a $ref node', () => {
    expect(validateAgainstJsonSchema(42, {type: ['string', 'null']})).toBe(42);
    expect(validateAgainstJsonSchema(42, {$ref: '#/definitions/X'})).toBe(42);
  });
});

describe('validateAgainstJsonSchema — integer', () => {
  const schema = {type: 'integer'};

  it('accepts an integer', () => {
    expect(validateAgainstJsonSchema(42, schema)).toBe(42);
  });

  it('coerces a numeric string', () => {
    expect(validateAgainstJsonSchema('42', schema)).toBe(42);
    expect(validateAgainstJsonSchema(' -7 ', schema)).toBe(-7);
  });

  it('rejects a non-numeric string', () => {
    expect(() => validateAgainstJsonSchema('abc', schema)).toThrow(
      'Failed to coerce data to integer: expected integer, got "abc"',
    );
  });

  it('rejects a fractional number', () => {
    expect(() => validateAgainstJsonSchema(42.5, schema)).toThrow(
      'expected integer, got 42.5',
    );
  });

  it('rejects a number beyond the safe integer range', () => {
    expect(() =>
      validateAgainstJsonSchema(Number.MAX_SAFE_INTEGER + 2, schema),
    ).toThrow('Failed to coerce data to integer');
  });

  it('rejects a digit string beyond the safe integer range', () => {
    expect(() => validateAgainstJsonSchema('9007199254740993', schema)).toThrow(
      'Failed to coerce data to integer',
    );
  });
});

describe('validateAgainstJsonSchema — number', () => {
  const schema = {type: 'number'};

  it('accepts a float', () => {
    expect(validateAgainstJsonSchema(42.5, schema)).toBe(42.5);
  });

  it('coerces a decimal string', () => {
    expect(validateAgainstJsonSchema('42.5', schema)).toBe(42.5);
  });

  it('rejects a non-numeric string, an empty string and NaN', () => {
    expect(() => validateAgainstJsonSchema('abc', schema)).toThrow(
      'Failed to coerce data to number',
    );
    expect(() => validateAgainstJsonSchema('', schema)).toThrow(
      'expected number, got ""',
    );
    expect(() => validateAgainstJsonSchema(NaN, schema)).toThrow(
      'expected number, got NaN',
    );
  });
});

describe('validateAgainstJsonSchema — boolean', () => {
  const schema = {type: 'boolean'};

  it('accepts a boolean', () => {
    expect(validateAgainstJsonSchema(true, schema)).toBe(true);
    expect(validateAgainstJsonSchema(false, schema)).toBe(false);
  });

  it('coerces the truthy and falsy strings', () => {
    expect(validateAgainstJsonSchema('true', schema)).toBe(true);
    expect(validateAgainstJsonSchema('1', schema)).toBe(true);
    expect(validateAgainstJsonSchema('false', schema)).toBe(false);
    expect(validateAgainstJsonSchema('0', schema)).toBe(false);
  });

  it('coerces case-insensitively', () => {
    expect(validateAgainstJsonSchema(' TRUE ', schema)).toBe(true);
  });

  it('rejects any other string', () => {
    expect(() => validateAgainstJsonSchema('maybe', schema)).toThrow(
      'Failed to coerce data to boolean: expected boolean, got "maybe"',
    );
  });

  it('rejects a string naming an Object.prototype member', () => {
    expect(() => validateAgainstJsonSchema('constructor', schema)).toThrow(
      'Failed to coerce data to boolean',
    );
  });

  it('rejects a number', () => {
    expect(() => validateAgainstJsonSchema(1, schema)).toThrow(
      'expected boolean, got 1',
    );
  });
});

describe('validateAgainstJsonSchema — string', () => {
  const schema = {type: 'string'};

  it('accepts a string', () => {
    expect(validateAgainstJsonSchema('hi', schema)).toBe('hi');
  });

  it('rejects a number, with no number-to-string coercion', () => {
    expect(() => validateAgainstJsonSchema(42, schema)).toThrow(
      'Failed to coerce data to string: expected string, got 42',
    );
  });
});

describe('validateAgainstJsonSchema — array', () => {
  const schema = {type: 'array'};

  it('accepts an array', () => {
    expect(validateAgainstJsonSchema([1, 2], schema)).toEqual([1, 2]);
  });

  it('rejects a string and an object', () => {
    expect(() => validateAgainstJsonSchema('not a list', schema)).toThrow(
      'Failed to coerce data to array: expected array, got "not a list"',
    );
    expect(() => validateAgainstJsonSchema({a: 1}, schema)).toThrow(
      'expected array, got object',
    );
  });
});

describe('validateAgainstJsonSchema — object', () => {
  it('accepts any object when the schema declares no properties', () => {
    expect(
      validateAgainstJsonSchema({name: 'Alice'}, {type: 'object'}),
    ).toEqual({name: 'Alice'});
  });

  it('rejects a string, null and an array', () => {
    const schema = {type: 'object'};
    expect(() => validateAgainstJsonSchema('not a dict', schema)).toThrow(
      'Failed to coerce data to object: expected object, got "not a dict"',
    );
    expect(() => validateAgainstJsonSchema(null, schema)).toThrow(
      'expected object, got null',
    );
    expect(() => validateAgainstJsonSchema([1, 2], schema)).toThrow(
      'expected object, got array',
    );
  });

  it('ignores a properties key that is not an object', () => {
    const schema = {type: 'object', properties: 'nope'};
    expect(validateAgainstJsonSchema({a: 1}, schema)).toEqual({a: 1});
  });

  it('accepts an object conforming to its properties', () => {
    const schema = {
      type: 'object',
      properties: {name: {type: 'string'}, age: {type: 'integer'}},
      required: ['name'],
    };
    expect(validateAgainstJsonSchema({name: 'Alice', age: 30}, schema)).toEqual(
      {name: 'Alice', age: 30},
    );
  });

  it('names the property when a required one is missing', () => {
    const schema = {
      type: 'object',
      properties: {name: {type: 'string'}},
      required: ['name'],
    };
    expect(() => validateAgainstJsonSchema({}, schema)).toThrow(
      "Validation failed for object schema: property 'name': required property is missing",
    );
  });

  it('names the property when a present one has the wrong type', () => {
    const schema = {
      type: 'object',
      properties: {age: {type: 'integer'}},
    };
    expect(() => validateAgainstJsonSchema({age: null}, schema)).toThrow(
      "Validation failed for object schema: property 'age': Failed to coerce data to integer: expected integer, got null",
    );
  });

  it('accepts an absent non-required property', () => {
    const schema = {
      type: 'object',
      properties: {name: {type: 'string'}, age: {type: 'integer'}},
      required: ['name'],
    };
    expect(validateAgainstJsonSchema({name: 'Alice'}, schema)).toEqual({
      name: 'Alice',
    });
  });

  it('treats a non-array required key as no requirement', () => {
    const schema = {
      type: 'object',
      properties: {name: {type: 'string'}},
      required: 'name',
    };
    expect(validateAgainstJsonSchema({}, schema)).toEqual({});
  });

  it('coerces a property and preserves a key outside properties', () => {
    const schema = {type: 'object', properties: {age: {type: 'integer'}}};
    expect(
      validateAgainstJsonSchema({age: '30', nickname: 'Al'}, schema),
    ).toEqual({age: 30, nickname: 'Al'});
  });

  it('validates a nested object property recursively', () => {
    const schema = {
      type: 'object',
      properties: {
        user: {type: 'object', properties: {age: {type: 'integer'}}},
      },
    };
    expect(validateAgainstJsonSchema({user: {age: '41'}}, schema)).toEqual({
      user: {age: 41},
    });
    expect(() =>
      validateAgainstJsonSchema({user: {age: 'old'}}, schema),
    ).toThrow(
      "property 'user': Validation failed for object schema: property 'age'",
    );
  });
});

describe('validateAgainstJsonSchema — genai Schema shapes', () => {
  it('honours uppercase type names', () => {
    const schema = {type: 'OBJECT', properties: {answer: {type: 'STRING'}}};
    expect(validateAgainstJsonSchema({answer: 'yes'}, schema)).toEqual({
      answer: 'yes',
    });
    expect(() => validateAgainstJsonSchema({answer: 42}, schema)).toThrow(
      "property 'answer': Failed to coerce data to string",
    );
  });

  it('accepts null for a nullable schema', () => {
    expect(
      validateAgainstJsonSchema(null, {type: 'STRING', nullable: true}),
    ).toBeNull();
  });

  it('still rejects null for a non-nullable schema', () => {
    expect(() =>
      validateAgainstJsonSchema(null, {type: 'STRING', nullable: false}),
    ).toThrow('Failed to coerce data to string');
  });
});
