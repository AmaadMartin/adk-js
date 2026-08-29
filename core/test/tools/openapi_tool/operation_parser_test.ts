/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {OperationParser} from '@google/adk';
import {OpenAPIV3} from 'openapi-types';
import {describe, expect, it} from 'vitest';

describe('OperationParser', () => {
  it('should throw error if operationId is missing', () => {
    const op: OpenAPIV3.OperationObject = {
      responses: {},
    };
    const parser = new OperationParser(op);
    expect(() => parser.getFunctionName()).toThrow('Operation ID is missing');
  });

  it('should parse array request body', () => {
    const op: OpenAPIV3.OperationObject = {
      operationId: 'testOp',
      requestBody: {
        content: {
          'application/json': {
            schema: {
              type: 'array',
              items: {type: 'string'},
            },
          },
        },
      },
      responses: {},
    };

    const parser = new OperationParser(op);
    const params = parser.getParameters();

    expect(params.length).toBe(1);
    expect(params[0].name).toBe('body');
    expect(params[0].paramLocation).toBe('body');
    expect(params[0].paramSchema.type).toBe('array');
  });

  it('should parse primitive request body', () => {
    const op: OpenAPIV3.OperationObject = {
      operationId: 'testOp',
      requestBody: {
        content: {
          'application/json': {
            schema: {
              type: 'string',
            },
          },
        },
      },
      responses: {},
    };

    const parser = new OperationParser(op);
    const params = parser.getParameters();

    expect(params.length).toBe(1);
    expect(params[0].name).toBe('body');
    expect(params[0].paramLocation).toBe('body');
    expect(params[0].paramSchema.type).toBe('string');
  });

  it('should parse response schema', () => {
    const op: OpenAPIV3.OperationObject = {
      operationId: 'testOp',
      responses: {
        '200': {
          description: 'OK',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  id: {type: 'integer'},
                },
              },
            },
          },
        },
      },
    };

    const parser = new OperationParser(op);
    const schema = parser.getJsonSchema();

    expect(schema).toBeTruthy();
    expect(schema.title).toBe('testOp_Arguments');
  });

  it.each([
    ['calendar.events.list', 'calendar_events_list'],
    ['youtube.liveBroadcasts.list', 'youtube_live_broadcasts_list'],
    ['get__test', 'get_test'],
  ])('names the function %j as %j', (operationId, expected) => {
    const op: OpenAPIV3.OperationObject = {operationId, responses: {}};

    expect(new OperationParser(op).getFunctionName()).toBe(expected);
  });

  it('truncates a normalized function name to 60 characters', () => {
    const op: OpenAPIV3.OperationObject = {
      operationId:
        'calendar.events.instances.list.with.a.very.long.trailing.suffix',
      responses: {},
    };

    const name = new OperationParser(op).getFunctionName();

    expect(name).toBe(
      'calendar_events_instances_list_with_a_very_long_trailing_suf',
    );
    expect(name).toHaveLength(60);
  });

  it('normalizes a separated parameter name', () => {
    const op: OpenAPIV3.OperationObject = {
      operationId: 'testOp',
      parameters: [
        {name: 'user-id', in: 'path', required: true, schema: {type: 'string'}},
      ],
      responses: {},
    };

    const params = new OperationParser(op).getParameters();

    expect(params[0].name).toBe('user_id');
    expect(params[0].originalName).toBe('user-id');
  });

  it('preserves a separated parameter name when asked to', () => {
    const op: OpenAPIV3.OperationObject = {
      operationId: 'testOp',
      parameters: [
        {name: 'user-id', in: 'path', required: true, schema: {type: 'string'}},
      ],
      responses: {},
    };

    const params = new OperationParser(op, {
      preservePropertyNames: true,
    }).getParameters();

    expect(params[0].name).toBe('user-id');
  });
});
