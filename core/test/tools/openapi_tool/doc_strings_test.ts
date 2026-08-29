/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {ApiParameter} from '@google/adk';
import {OpenAPIV3} from 'openapi-types';
import {describe, expect, it} from 'vitest';
import {
  generateParamDoc,
  generateReturnDoc,
  typeHint,
} from '../../../src/tools/openapi_tool/openapi_spec_parser/doc_strings.js';

function apiParameter(
  paramSchema: OpenAPIV3.SchemaObject,
  description?: string,
): ApiParameter {
  return {
    originalName: 'thing',
    paramLocation: 'query',
    paramSchema,
    description,
    name: 'thing',
    required: false,
  };
}

describe('doc_strings', () => {
  describe('typeHint', () => {
    it('should name a string schema', () => {
      expect(typeHint({type: 'string'})).toBe('string');
    });

    it('should name integer and number as number', () => {
      expect(typeHint({type: 'integer'})).toBe('number');
      expect(typeHint({type: 'number'})).toBe('number');
    });

    it('should name a boolean schema', () => {
      expect(typeHint({type: 'boolean'})).toBe('boolean');
    });

    it('should name an object schema', () => {
      expect(typeHint({type: 'object'})).toBe('Record<string, unknown>');
    });

    it('should name an array of objects', () => {
      expect(typeHint({type: 'array', items: {type: 'object'}})).toBe(
        'Array<Record<string, unknown>>',
      );
    });

    it('should name an array of scalars', () => {
      expect(typeHint({type: 'array', items: {type: 'string'}})).toBe(
        'Array<string>',
      );
      expect(typeHint({type: 'array', items: {type: 'integer'}})).toBe(
        'Array<number>',
      );
      expect(typeHint({type: 'array', items: {type: 'boolean'}})).toBe(
        'Array<boolean>',
      );
    });

    it('should name an array whose items are a reference', () => {
      expect(
        typeHint({type: 'array', items: {$ref: '#/components/schemas/Pet'}}),
      ).toBe('Array<unknown>');
    });

    it('should name an array of arrays', () => {
      expect(
        typeHint({
          type: 'array',
          items: {type: 'array', items: {type: 'string'}},
        }),
      ).toBe('Array<unknown>');
    });

    it('should name a typeless schema unknown', () => {
      expect(typeHint({})).toBe('unknown');
    });
  });

  describe('generateParamDoc', () => {
    it('should document a scalar argument', () => {
      expect(
        generateParamDoc(apiParameter({type: 'string'}, '  Trace id  ')),
      ).toBe('thing (string): Trace id');
    });

    it('should document an argument with no description', () => {
      expect(generateParamDoc(apiParameter({type: 'integer'}))).toBe(
        'thing (number): ',
      );
    });

    it('should list the properties of an object argument', () => {
      const doc = generateParamDoc(
        apiParameter({
          type: 'object',
          properties: {
            prop1: {type: 'string', description: 'Property 1'},
            prop2: {type: 'integer'},
          },
        }),
      );

      expect(doc).toBe(
        'thing (Record<string, unknown>):  Object properties:\n' +
          '       prop1 (string): Property 1\n' +
          '       prop2 (number): \n',
      );
    });

    it('should describe a referenced property as unknown', () => {
      const doc = generateParamDoc(
        apiParameter({
          type: 'object',
          properties: {pet: {$ref: '#/components/schemas/Pet'}},
        }),
      );

      expect(doc).toContain('       pet (unknown): \n');
    });

    it('should list no properties for an empty object argument', () => {
      expect(generateParamDoc(apiParameter({type: 'object'}))).toBe(
        'thing (Record<string, unknown>): ',
      );
    });
  });

  describe('generateReturnDoc', () => {
    it('should return nothing when no response is a 2xx', () => {
      expect(
        generateReturnDoc({
          '400': {
            description: 'Bad request',
            content: {'application/json': {schema: {type: 'string'}}},
          },
        }),
      ).toBe('');
    });

    it('should return nothing when the 2xx response has no content', () => {
      expect(generateReturnDoc({'204': {description: 'No content'}})).toBe('');
    });

    it('should return nothing when the 2xx response is a reference', () => {
      expect(
        generateReturnDoc({'200': {$ref: '#/components/responses/Ok'}}),
      ).toBe('');
    });

    it('should prefer the application/json media type', () => {
      expect(
        generateReturnDoc({
          '200': {
            description: 'Success',
            content: {
              'text/plain': {schema: {type: 'boolean'}},
              'application/json': {schema: {type: 'string'}},
            },
          },
        }),
      ).toBe('Returns (string): Success');
    });

    it('should use the only media type when json is absent', () => {
      expect(
        generateReturnDoc({
          '200': {
            description: 'Success',
            content: {'text/plain': {schema: {type: 'boolean'}}},
          },
        }),
      ).toBe('Returns (boolean): Success');
    });

    it('should describe a media type with no schema as unknown', () => {
      expect(
        generateReturnDoc({
          '200': {description: 'Success', content: {'text/plain': {}}},
        }),
      ).toBe('Returns (unknown): Success');
    });

    it('should order a numeric status before default', () => {
      expect(
        generateReturnDoc({
          'default': {
            description: 'Fallback',
            content: {'application/json': {schema: {type: 'boolean'}}},
          },
          '200': {
            description: 'Success',
            content: {'application/json': {schema: {type: 'string'}}},
          },
        }),
      ).toBe('Returns (string): Success');
    });

    it('should order a numeric status before a range status', () => {
      expect(
        generateReturnDoc({
          '2XX': {
            description: 'Any success',
            content: {'application/json': {schema: {type: 'boolean'}}},
          },
          '201': {
            description: 'Created',
            content: {'application/json': {schema: {type: 'string'}}},
          },
        }),
      ).toBe('Returns (string): Created');
    });

    it('should take the smallest 2xx status that carries content', () => {
      expect(
        generateReturnDoc({
          '202': {
            description: 'Accepted',
            content: {'application/json': {schema: {type: 'string'}}},
          },
          '200': {description: 'Success'},
        }),
      ).toBe('Returns (string): Accepted');
    });

    it('should list the properties of an object response', () => {
      expect(
        generateReturnDoc({
          '200': {
            description: '  Success  ',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {id: {type: 'integer', description: 'The id'}},
                },
              },
            },
          },
        }),
      ).toBe(
        'Returns (Record<string, unknown>): Success Object properties:\n' +
          '        id (number): The id\n',
      );
    });
  });
});
