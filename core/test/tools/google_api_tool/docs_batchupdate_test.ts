/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {convertDiscoveryDocument} from '@google/adk';
import {OpenAPIV3} from 'openapi-types';
import {describe, expect, it} from 'vitest';
import {DOCS_DISCOVERY_DOCUMENT} from './discovery_fixtures.js';
import {
  asReference,
  asSchema,
  operationAt,
  parametersByName,
  requestBodyOf,
  responseAt,
} from './openapi_narrowing.js';

const SPEC = convertDiscoveryDocument(DOCS_DISCOVERY_DOCUMENT, 'docs', 'v1');
const BATCH_UPDATE_PATH = '/v1/documents/{documentId}:batchUpdate';

function schemaNamed(name: string): OpenAPIV3.SchemaObject {
  return asSchema(SPEC.components?.schemas?.[name]);
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
    const batchUpdate = operationAt(SPEC.paths, BATCH_UPDATE_PATH, 'post');

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
    const documentId = parametersByName(
      operationAt(SPEC.paths, BATCH_UPDATE_PATH, 'post'),
    )['documentId'];

    // The `:batchUpdate` suffix hides the placeholder from path extraction, so
    // the parameter arrives through the declared-parameter list instead.
    expect(documentId.in).toBe('path');
    expect(documentId.required).toBe(true);
    expect(asSchema(documentId.schema).type).toBe('string');
  });

  it('resolves the batchUpdate request and response references', () => {
    const batchUpdate = operationAt(SPEC.paths, BATCH_UPDATE_PATH, 'post');
    const requestBody = requestBodyOf(batchUpdate);
    const response = responseAt(batchUpdate, '200');

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
    const get = operationAt(SPEC.paths, '/v1/documents/{documentId}', 'get');
    const documentId = parametersByName(get)['documentId'];

    expect(get.operationId).toBe('docs.documents.get');
    expect(documentId.required).toBe(true);
    expect(asSchema(documentId.schema).type).toBe('string');
  });

  it('converts the documents create operation', () => {
    const create = operationAt(SPEC.paths, '/v1/documents', 'post');
    const requestBody = requestBodyOf(create);

    expect(create.operationId).toBe('docs.documents.create');
    expect(
      asReference(requestBody.content['application/json'].schema).$ref,
    ).toBe('#/components/schemas/Document');
  });
});
