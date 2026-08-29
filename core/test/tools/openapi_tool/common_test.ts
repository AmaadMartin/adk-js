/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {createApiParameter} from '@google/adk';
import {describe, expect, it} from 'vitest';

describe('createApiParameter', () => {
  it('should derive a snake_case name from the original name', () => {
    const param = createApiParameter({
      originalName: 'testParam',
      paramLocation: 'query',
      paramSchema: {type: 'string', description: 'Test description'},
    });

    expect(param.name).toBe('test_param');
    expect(param.originalName).toBe('testParam');
    expect(param.paramLocation).toBe('query');
    expect(param.description).toBe('Test description');
    expect(param.paramSchema).toEqual({
      type: 'string',
      description: 'Test description',
    });
    expect(param.required).toBe(false);
  });

  it('should prefer an explicit description over the schema description', () => {
    const param = createApiParameter({
      originalName: 'testParam',
      paramLocation: 'query',
      paramSchema: {type: 'string', description: 'From schema'},
      description: 'Explicit',
    });

    expect(param.description).toBe('Explicit');
  });

  it('should fall back to an empty description', () => {
    const param = createApiParameter({
      originalName: 'testParam',
      paramLocation: 'query',
      paramSchema: {type: 'string'},
    });

    expect(param.description).toBe('');
  });

  it.each([
    ['body', 'body'],
    ['query', 'query_param'],
    ['path', 'path_param'],
    ['header', 'header_param'],
    ['cookie', 'cookie_param'],
    ['unknown', 'value'],
    ['constructor', 'value'],
  ])('should name an unnamed %s parameter %s', (location, expected) => {
    const param = createApiParameter({
      originalName: '',
      paramLocation: location,
      paramSchema: {type: 'string'},
    });

    expect(param.name).toBe(expected);
  });

  it.each([
    ['in', 'param_in'],
    ['class', 'param_class'],
    ['function', 'param_function'],
    ['await', 'param_await'],
    ['let', 'param_let'],
    ['typeof', 'param_typeof'],
  ])('should prefix the reserved word %s', (original, expected) => {
    const param = createApiParameter({
      originalName: original,
      paramLocation: 'query',
      paramSchema: {type: 'string'},
    });

    expect(param.name).toBe(expected);
  });

  it('should prefix a name the snake_case rule turns into a reserved word', () => {
    const param = createApiParameter({
      originalName: 'Class',
      paramLocation: 'query',
      paramSchema: {type: 'string'},
    });

    expect(param.name).toBe('param_class');
  });

  it('should leave a name that only begins with a reserved word', () => {
    const param = createApiParameter({
      originalName: 'className',
      paramLocation: 'query',
      paramSchema: {type: 'string'},
    });

    expect(param.name).toBe('class_name');
  });

  it('should not prefix an explicit name that is a reserved word', () => {
    const param = createApiParameter({
      originalName: 'petId',
      paramLocation: 'query',
      paramSchema: {type: 'string'},
      name: 'class',
    });

    expect(param.name).toBe('class');
  });

  it('should let an explicit name win', () => {
    const param = createApiParameter({
      originalName: 'testParam',
      paramLocation: 'query',
      paramSchema: {type: 'string'},
      name: 'chosen',
    });

    expect(param.name).toBe('chosen');
  });

  it('should keep an explicit required flag', () => {
    const param = createApiParameter({
      originalName: 'testParam',
      paramLocation: 'query',
      paramSchema: {type: 'string'},
      required: true,
    });

    expect(param.required).toBe(true);
  });

  it('should parse a schema held as a JSON string', () => {
    const param = createApiParameter({
      originalName: 'testParam',
      paramLocation: 'query',
      paramSchema: '{"type":"string","description":"From JSON"}',
    });

    expect(param.paramSchema).toEqual({
      type: 'string',
      description: 'From JSON',
    });
    expect(param.description).toBe('From JSON');
  });

  it('should reject a JSON string schema that does not parse', () => {
    expect(() =>
      createApiParameter({
        originalName: 'petId',
        paramLocation: 'query',
        paramSchema: '{oops',
      }),
    ).toThrow("parameter 'petId' schema is not valid JSON");
  });

  it.each([
    ['a scalar', '"nope"', 'got string'],
    ['an array', '[]', 'got array'],
  ])(
    'should reject a JSON string schema holding %s',
    (_name, json, expected) => {
      expect(() =>
        createApiParameter({
          originalName: 'petId',
          paramLocation: 'query',
          paramSchema: json,
        }),
      ).toThrow(
        `parameter 'petId' schema must be an OpenAPI schema, ${expected}`,
      );
    },
  );

  it('should reject a schema that is a number', () => {
    expect(() =>
      createApiParameter({
        originalName: 'petId',
        paramLocation: 'query',
        paramSchema: '7',
      }),
    ).toThrow("parameter 'petId' schema must be an OpenAPI schema, got number");
  });

  it('should treat an absent schema as unconstrained', () => {
    const param = createApiParameter({
      originalName: 'testParam',
      paramLocation: 'query',
    });

    expect(param.paramSchema).toEqual({});
  });

  it('should treat a true schema as unconstrained', () => {
    const param = createApiParameter({
      originalName: 'testParam',
      paramLocation: 'query',
      paramSchema: true,
    });

    expect(param.paramSchema).toEqual({});
  });

  it('should reject a false schema', () => {
    expect(() =>
      createApiParameter({
        originalName: 'petId',
        paramLocation: 'query',
        paramSchema: false,
      }),
    ).toThrow("parameter 'petId' schema uses an unsatisfiable false schema");
  });

  it('should reject an unresolved reference and name it', () => {
    expect(() =>
      createApiParameter({
        originalName: 'petId',
        paramLocation: 'query',
        paramSchema: {$ref: '#/components/schemas/Pet'},
      }),
    ).toThrow(
      "parameter 'petId' schema contains unresolved reference '#/components/schemas/Pet'",
    );
  });

  it('should not modify the values it was given', () => {
    const init = {
      originalName: 'testParam',
      paramLocation: 'query',
      paramSchema: {type: 'string' as const, description: 'From schema'},
    };
    const clone = structuredClone(init);

    createApiParameter(init);

    expect(init).toEqual(clone);
  });
});
