/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {OpenAPIV3} from 'openapi-types';
import {expect} from 'vitest';

/**
 * Narrowing helpers for asserting on a converted OpenAPI document. They fail
 * the test rather than casting, so a wrong shape is reported where it happens.
 */

/** Narrows a possibly-referenced schema to a concrete schema object. */
export function asSchema(
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
export function asReference(
  schema: OpenAPIV3.SchemaObject | OpenAPIV3.ReferenceObject | undefined,
): OpenAPIV3.ReferenceObject {
  if (!schema || !('$ref' in schema)) {
    return expect.fail(
      `expected a reference object, got ${JSON.stringify(schema)}`,
    );
  }
  return schema;
}

/** Narrows an operation out of a converted paths object. */
export function operationAt(
  paths: OpenAPIV3.PathsObject,
  path: string,
  method: 'get' | 'post',
): OpenAPIV3.OperationObject {
  const operation = paths[path]?.[method];
  if (!operation) {
    return expect.fail(`expected a ${method} operation at ${path}`);
  }
  return operation;
}

/** Narrows one response of an operation to a concrete response object. */
export function responseAt(
  operation: OpenAPIV3.OperationObject,
  status: string,
): OpenAPIV3.ResponseObject {
  const response = operation.responses?.[status];
  if (!response || '$ref' in response) {
    return expect.fail(`expected a ${status} response object`);
  }
  return response;
}

/** Narrows the request body of an operation. */
export function requestBodyOf(
  operation: OpenAPIV3.OperationObject,
): OpenAPIV3.RequestBodyObject {
  const requestBody = operation.requestBody;
  if (!requestBody || '$ref' in requestBody) {
    return expect.fail('expected a request body object');
  }
  return requestBody;
}

/** Indexes the parameters of an operation by name. */
export function parametersByName(
  operation: OpenAPIV3.OperationObject,
): Record<string, OpenAPIV3.ParameterObject> {
  const byName: Record<string, OpenAPIV3.ParameterObject> = {};
  for (const parameter of operation.parameters ?? []) {
    if ('name' in parameter) {
      byName[parameter.name] = parameter;
    }
  }
  return byName;
}
