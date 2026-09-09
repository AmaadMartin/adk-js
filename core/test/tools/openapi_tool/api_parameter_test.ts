/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {describe, expect, it} from 'vitest';
import {createApiParameter} from '../../../src/tools/openapi_tool/api_parameter.js';

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

  it('should treat an absent schema as unconstrained', () => {
    const param = createApiParameter({
      originalName: 'testParam',
      paramLocation: 'query',
    });

    expect(param.paramSchema).toEqual({});
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
