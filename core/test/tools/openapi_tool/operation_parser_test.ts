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

  it('should snake_case an operationId that already contains a separator', () => {
    const op: OpenAPIV3.OperationObject = {
      operationId: 'jira_list_Issues',
      responses: {},
    };

    expect(new OperationParser(op).getFunctionName()).toBe('jira_list_issues');
  });

  it('should snake_case parameter names but keep the wire names', () => {
    const op: OpenAPIV3.OperationObject = {
      operationId: 'getPet',
      parameters: [
        {name: 'X-API-Key', in: 'header'},
        {name: 'Issue_Id', in: 'query'},
      ],
      responses: {},
    };

    const params = new OperationParser(op).getParameters();

    expect(params.map((p) => p.name)).toEqual(['x_api_key', 'issue_id']);
    expect(params.map((p) => p.originalName)).toEqual([
      'X-API-Key',
      'Issue_Id',
    ]);
  });

  it('should snake_case request body property names', () => {
    const op: OpenAPIV3.OperationObject = {
      operationId: 'createPet',
      requestBody: {
        content: {
          'application/json': {
            schema: {
              type: 'object',
              properties: {
                userName: {type: 'string'},
                HTTPCode: {type: 'integer'},
              },
            },
          },
        },
      },
      responses: {},
    };

    const parser = new OperationParser(op);
    const params = parser.getParameters();

    expect(params.map((p) => p.name)).toEqual(['user_name', 'http_code']);
    expect(params.map((p) => p.originalName)).toEqual(['userName', 'HTTPCode']);
    expect(
      Object.keys(parser.getJsonSchema().properties as Record<string, unknown>),
    ).toEqual(['user_name', 'http_code']);
  });

  it('should keep original names when preservePropertyNames is set', () => {
    const op: OpenAPIV3.OperationObject = {
      operationId: 'getPet',
      parameters: [
        {name: 'X-API-Key', in: 'header'},
        {name: 'Issue_Id', in: 'query'},
      ],
      responses: {},
    };

    const params = new OperationParser(op, {
      preservePropertyNames: true,
    }).getParameters();

    expect(params.map((p) => p.name)).toEqual(['X-API-Key', 'Issue_Id']);
  });

  it('should truncate the function name to 60 characters after conversion', () => {
    const operationId =
      'getVeryLongOperation-Name-ThatKeepsGoingWellPastTheSixtyCharacterLimit';
    const op: OpenAPIV3.OperationObject = {operationId, responses: {}};

    const name = new OperationParser(op).getFunctionName();

    expect(name.length).toBe(60);
    expect(name).toBe(
      'get_very_long_operation_name_that_keeps_going_well_past_the_',
    );
  });

  it('should dedupe parameter names that collide after conversion', () => {
    const op: OpenAPIV3.OperationObject = {
      operationId: 'getPet',
      parameters: [
        {name: 'X-API-Key', in: 'header'},
        {name: 'x_api_key', in: 'query'},
      ],
      responses: {},
    };

    const params = new OperationParser(op).getParameters();

    expect(params.map((p) => p.name)).toEqual(['x_api_key', 'x_api_key_1']);
  });

  it('should convert an empty parameter name to an empty name', () => {
    const op: OpenAPIV3.OperationObject = {
      operationId: 'getPet',
      parameters: [{name: '', in: 'query'}],
      responses: {},
    };

    expect(new OperationParser(op).getParameters()[0].name).toBe('');
  });
});
