/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {convertDiscoveryDocument} from '@google/adk';
import {OpenAPIV3} from 'openapi-types';
import {describe, expect, it} from 'vitest';
import {DOCS_DISCOVERY_DOCUMENT} from './discovery_fixtures.js';

const SPEC = convertDiscoveryDocument(DOCS_DISCOVERY_DOCUMENT, 'docs', 'v1');
const BATCH_UPDATE_PATH = '/v1/documents/{documentId}:batchUpdate';

/** Narrows a possibly-referenced schema to a concrete schema object. */
function asSchema(
  schema: OpenAPIV3.SchemaObject | OpenAPIV3.ReferenceObject | undefined,
): OpenAPIV3.SchemaObject {
  if (!schema || '$ref' in schema) {
    return expect.fail(
      `expected a schema object, got ${JSON.stringify(schema)}`,
    );
  }
  return schema;
}

/** Narrows a possibly-referenced schema to a reference object. */
function asReference(
  schema: OpenAPIV3.SchemaObject | OpenAPIV3.ReferenceObject | undefined,
): OpenAPIV3.ReferenceObject {
  if (!schema || !('$ref' in schema)) {
    return expect.fail(
      `expected a reference object, got ${JSON.stringify(schema)}`,
    );
  }
  return schema;
}

function schemaNamed(name: string): OpenAPIV3.SchemaObject {
  return asSchema(SPEC.components?.schemas?.[name]);
}

function operationAt(
  path: string,
  method: 'get' | 'post',
): OpenAPIV3.OperationObject {
  const operation = SPEC.paths[path]?.[method];
  if (!operation) {
    return expect.fail(`expected a ${method} operation at ${path}`);
  }
  return operation;
}

describe('Google Docs discovery conversion', () => {
  it('serves the documents API from its own host', () => {
    expect(SPEC.servers?.[0].url).toBe('https://docs.googleapis.com');
    expect(SPEC.info.title).toBe('Google Docs API');
  });

  it('exposes get, create and batchUpdate paths', () => {
    expect(Object.keys(SPEC.paths).sort()).toEqual([
      '/v1/documents',
      '/v1/documents/{documentId}',
      BATCH_UPDATE_PATH,
    ]);
  });

  it('converts batchUpdate into a post operation', () => {
    const batchUpdate = operationAt(BATCH_UPDATE_PATH, 'post');

    expect(batchUpdate.operationId).toBe('docs.documents.batchUpdate');
    expect(batchUpdate.summary).toBe(
      'Applies one or more updates to the document.',
    );
    expect(batchUpdate.security).toEqual([
      {
        oauth2: [
          'https://www.googleapis.com/auth/documents',
          'https://www.googleapis.com/auth/drive',
          'https://www.googleapis.com/auth/drive.file',
        ],
      },
    ]);
  });

  it('keeps documentId as a declared parameter despite the trailing verb', () => {
    const parameters = operationAt(BATCH_UPDATE_PATH, 'post').parameters ?? [];
    const documentId = parameters.find(
      (parameter) => 'name' in parameter && parameter.name === 'documentId',
    );
    if (!documentId || !('name' in documentId)) {
      return expect.fail('expected a documentId parameter');
    }

    // The `:batchUpdate` suffix hides the placeholder from path extraction, so
    // the parameter arrives through the declared-parameter list instead.
    expect(documentId.in).toBe('path');
    expect(documentId.required).toBe(true);
    expect(asSchema(documentId.schema).type).toBe('string');
  });

  it('resolves the batchUpdate request and response references', () => {
    const batchUpdate = operationAt(BATCH_UPDATE_PATH, 'post');
    const requestBody = batchUpdate.requestBody;
    if (!requestBody || '$ref' in requestBody) {
      return expect.fail('expected a request body object');
    }
    const response = batchUpdate.responses?.['200'];
    if (!response || '$ref' in response) {
      return expect.fail('expected a 200 response object');
    }

    expect(requestBody.required).toBe(true);
    expect(
      asReference(requestBody.content['application/json'].schema).$ref,
    ).toBe('#/components/schemas/BatchUpdateDocumentRequest');
    expect(
      asReference(response.content?.['application/json'].schema).$ref,
    ).toBe('#/components/schemas/BatchUpdateDocumentResponse');
  });

  it('converts the batchUpdate request schema', () => {
    const request = schemaNamed('BatchUpdateDocumentRequest');

    expect(request.type).toBe('object');
    expect(Object.keys(request.properties ?? {})).toEqual([
      'requests',
      'writeControl',
    ]);

    const requests = asSchema(request.properties?.['requests']);
    if (requests.type !== 'array') {
      return expect.fail('expected an array schema');
    }
    expect(asReference(requests.items).$ref).toBe(
      '#/components/schemas/Request',
    );
  });

  it('converts the batchUpdate response schema', () => {
    const response = schemaNamed('BatchUpdateDocumentResponse');

    expect(response.type).toBe('object');
    expect(Object.keys(response.properties ?? {})).toEqual([
      'documentId',
      'replies',
      'writeControl',
    ]);

    const replies = asSchema(response.properties?.['replies']);
    if (replies.type !== 'array') {
      return expect.fail('expected an array schema');
    }
    expect(asReference(replies.items).$ref).toBe(
      '#/components/schemas/Response',
    );
  });

  it('converts the nested update request schemas', () => {
    const request = schemaNamed('Request');
    expect(Object.keys(request.properties ?? {})).toEqual([
      'insertText',
      'updateTextStyle',
      'replaceAllText',
    ]);

    expect(
      Object.keys(schemaNamed('InsertTextRequest').properties ?? {}),
    ).toEqual(['location', 'text']);
    expect(
      Object.keys(schemaNamed('UpdateTextStyleRequest').properties ?? {}),
    ).toEqual(['range', 'textStyle', 'fields']);
  });

  it('converts the schemas a realistic batch update body needs', () => {
    expect(asSchema(schemaNamed('Location').properties?.['index']).type).toBe(
      'integer',
    );
    expect(Object.keys(schemaNamed('Range').properties ?? {})).toEqual([
      'startIndex',
      'endIndex',
    ]);
    expect(asSchema(schemaNamed('TextStyle').properties?.['bold']).type).toBe(
      'boolean',
    );
    expect(Object.keys(schemaNamed('WriteControl').properties ?? {})).toEqual([
      'requiredRevisionId',
      'targetRevisionId',
    ]);
  });

  it('converts the documents get operation', () => {
    const get = operationAt('/v1/documents/{documentId}', 'get');
    const documentId = (get.parameters ?? []).find(
      (parameter) => 'name' in parameter && parameter.name === 'documentId',
    );
    if (!documentId || !('name' in documentId)) {
      return expect.fail('expected a documentId parameter');
    }

    expect(get.operationId).toBe('docs.documents.get');
    expect(documentId.required).toBe(true);
    expect(asSchema(documentId.schema).type).toBe('string');
  });

  it('converts the documents create operation', () => {
    const create = operationAt('/v1/documents', 'post');
    const requestBody = create.requestBody;
    if (!requestBody || '$ref' in requestBody) {
      return expect.fail('expected a request body object');
    }

    expect(create.operationId).toBe('docs.documents.create');
    expect(
      asReference(requestBody.content['application/json'].schema).$ref,
    ).toBe('#/components/schemas/Document');
  });
});
