/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {OpenAPIV3} from 'openapi-types';
import {snakeCase} from '../../../utils/case_utils.js';
import {experimental} from '../../../utils/experimental.js';
import {ApiParameter, OperationParser} from './operation_parser.js';

const VALID_SCHEMA_TYPES = new Set([
  'array',
  'boolean',
  'integer',
  'null',
  'number',
  'object',
  'string',
]);

export interface OperationEndpoint {
  baseUrl: string;
  path: string;
  method: string;
}

export interface ParsedOperation {
  name: string;
  description: string;
  endpoint: OperationEndpoint;
  operation: OpenAPIV3.OperationObject;
  parameters: ApiParameter[];
  /**
   * The operation's response, taken from its lowest 2xx response code. Always
   * present; the schema is empty when the operation declares no 2xx response
   * with a schema.
   */
  returnValue: ApiParameter;
  authScheme?: OpenAPIV3.SecuritySchemeObject;
}

@experimental
export class OpenApiSpecParser {
  private preservePropertyNames: boolean;

  constructor(options: {preservePropertyNames?: boolean} = {}) {
    this.preservePropertyNames = options.preservePropertyNames ?? false;
  }

  /**
   * Parses an OpenAPI specification document and extracts a list of operations.
   *
   * @param openapiSpec The OpenAPI V3 document to parse.
   * @throws {TypeError} If the spec is not an object.
   * @returns An array of parsed operations.
   */
  @experimental
  public parse(openapiSpec: OpenAPIV3.Document): ParsedOperation[] {
    if (
      typeof openapiSpec !== 'object' ||
      openapiSpec === null ||
      Array.isArray(openapiSpec)
    ) {
      throw new TypeError('OpenAPI spec must be an object.');
    }
    const resolvedSpec = resolveReferences(openapiSpec);
    const sanitizedSpec = sanitizeSchemaTypes(resolvedSpec);
    return collectOperations(sanitizedSpec, {
      preservePropertyNames: this.preservePropertyNames,
    });
  }
}

/**
 * Resolves all internal $ref references in the OpenAPI spec document.
 */
function resolveReferences(spec: OpenAPIV3.Document): OpenAPIV3.Document {
  const resolvedCache = new Map<string, unknown>();
  const specCopy = JSON.parse(JSON.stringify(spec)); // Deep copy

  const recursiveResolve = (
    obj: unknown,
    currentDoc: OpenAPIV3.Document,
    seenRefs = new Set<string>(),
  ): unknown => {
    if (typeof obj !== 'object' || obj === null) {
      return obj;
    }

    if (Array.isArray(obj)) {
      return obj.map((item) => recursiveResolve(item, currentDoc, seenRefs));
    }

    const objRecord = obj as Record<string, unknown>;
    if ('$ref' in objRecord && typeof objRecord['$ref'] === 'string') {
      const refString = objRecord['$ref'] as string;

      if (seenRefs.has(refString) && !resolvedCache.has(refString)) {
        // Circular reference detected. Break cycle.
        const copy = {...objRecord};
        delete copy['$ref'];
        return copy;
      }

      seenRefs.add(refString);

      if (resolvedCache.has(refString)) {
        return resolvedCache.get(refString);
      }

      let resolvedValue = resolveRef(refString, currentDoc);
      if (resolvedValue !== undefined) {
        resolvedValue = recursiveResolve(resolvedValue, currentDoc, seenRefs);
        resolvedCache.set(refString, resolvedValue);
        return resolvedValue;
      } else {
        return obj;
      }
    }

    const newDict: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(objRecord)) {
      newDict[key] = recursiveResolve(value, currentDoc, seenRefs);
    }
    return newDict;
  };

  return recursiveResolve(specCopy, specCopy) as OpenAPIV3.Document;
}

/**
 * Resolves a single JSON reference string against the document.
 */
function resolveRef(
  refString: string,
  currentDoc: OpenAPIV3.Document,
): unknown {
  const parts = refString.split('/');
  if (parts[0] !== '#') {
    throw new Error(`External references not supported: ${refString}`);
  }

  let current: unknown = currentDoc;
  for (const part of parts.slice(1)) {
    if (typeof current === 'object' && current !== null && part in current) {
      current = (current as Record<string, unknown>)[part];
    } else {
      return undefined;
    }
  }
  return current;
}

/**
 * Sanitizes schema types in the spec to ensure compatibility with Gemini function calling.
 */
function sanitizeSchemaTypes(
  openapiSpec: OpenAPIV3.Document,
): OpenAPIV3.Document {
  const specCopy = JSON.parse(JSON.stringify(openapiSpec));

  const sanitizeTypeField = (schemaDict: Record<string, unknown>) => {
    if (!('type' in schemaDict)) return;

    const typeValue = schemaDict['type'];
    if (typeof typeValue === 'string') {
      const normalizedType = typeValue.toLowerCase();
      if (VALID_SCHEMA_TYPES.has(normalizedType)) {
        schemaDict['type'] = normalizedType;
      } else {
        delete schemaDict['type'];
      }
      return;
    }

    if (Array.isArray(typeValue)) {
      const validTypes: string[] = [];
      for (const entry of typeValue) {
        if (typeof entry !== 'string') continue;
        const normalizedEntry = entry.toLowerCase();
        if (
          VALID_SCHEMA_TYPES.has(normalizedEntry) &&
          !validTypes.includes(normalizedEntry)
        ) {
          validTypes.push(normalizedEntry);
        }
      }
      if (validTypes.length > 0) {
        schemaDict['type'] = validTypes;
      } else {
        delete schemaDict['type'];
      }
    }
  };

  const sanitizeRecursive = (obj: unknown, inSchema: boolean): unknown => {
    if (typeof obj !== 'object' || obj === null) {
      return obj;
    }

    if (Array.isArray(obj)) {
      return obj.map((item) => sanitizeRecursive(item, inSchema));
    }

    const objRecord = obj as Record<string, unknown>;
    if (inSchema) {
      sanitizeTypeField(objRecord);
    }

    for (const [key, value] of Object.entries(objRecord)) {
      const isSchemaContainer = key === 'schema' || key === 'schemas';
      objRecord[key] = sanitizeRecursive(value, inSchema || isSchemaContainer);
    }
    return objRecord;
  };

  return sanitizeRecursive(specCopy, false) as OpenAPIV3.Document;
}

/**
 * Resolves OpenAPI Server Object variables (`{name}`) in a server URL from
 * their declared `default`, falling back to the first `enum` entry.
 *
 * A placeholder with no declared variable is a spec error: left in place it
 * becomes a literal `{name}` in the request host.
 *
 * @throws {Error} If a placeholder has no variable declaring a value for it.
 */
function resolveServerUrl(server: OpenAPIV3.ServerObject): string {
  return server.url.replace(/\{([^{}]+)\}/g, (_, name: string) => {
    const variable = server.variables?.[name];
    const value = variable?.default || variable?.enum?.[0];
    if (!value) {
      throw new Error(
        `Unresolved server URL variable '${name}' in '${server.url}'. ` +
          `Declare a default under servers[].variables.`,
      );
    }
    return value;
  });
}

/**
 * Returns the scheme name a security requirement list requires, or `undefined`
 * when it requires none.
 *
 * An empty requirement object is the OpenAPI idiom for optional
 * authentication. A tool that carries an auth scheme stops and asks the caller
 * for a credential instead of sending the request, so an optional requirement
 * resolves to no scheme. A caller that does want to authenticate passes
 * `authScheme` and `authCredential` to the toolset.
 *
 * @param security The security requirement list to inspect.
 * @returns The required scheme name, or `undefined`.
 */
function requiredSchemeName(
  security?: OpenAPIV3.SecurityRequirementObject[],
): string | undefined {
  if (!security || security.length === 0) {
    return undefined;
  }
  if (security.some((requirement) => Object.keys(requirement).length === 0)) {
    return undefined;
  }
  return Object.keys(security[0])[0];
}

/**
 * Collects and parses all operations defined in the OpenAPI spec document.
 */
function collectOperations(
  spec: OpenAPIV3.Document,
  options: {preservePropertyNames?: boolean} = {},
): ParsedOperation[] {
  const preservePropertyNames = options.preservePropertyNames ?? false;
  const operations: ParsedOperation[] = [];
  const server = spec.servers?.[0];
  const baseUrl = server ? resolveServerUrl(server) : '';

  const globalSchemeName = requiredSchemeName(spec.security);

  const authSchemes =
    (spec.components?.securitySchemes as Record<
      string,
      OpenAPIV3.SecuritySchemeObject
    >) || {};

  for (const [path, pathItem] of Object.entries(spec.paths || {})) {
    if (!pathItem) continue;

    const methods = [
      'get',
      'post',
      'put',
      'delete',
      'patch',
      'head',
      'options',
      'trace',
    ] as const;

    for (const method of methods) {
      const operation = pathItem[method];
      if (!operation) continue;

      // Merge path level parameters
      const pathParams = pathItem.parameters || [];
      const opParams = operation.parameters || [];
      operation.parameters = [...opParams, ...pathParams];

      if (!operation.operationId) {
        operation.operationId = snakeCase(`${path}_${method}`);
      }

      const parser = new OperationParser(operation, {
        preservePropertyNames,
      });

      // Declaring security of its own overrides the global requirement, even
      // when the operation declares an empty list.
      const authSchemeName =
        operation.security === undefined
          ? globalSchemeName
          : requiredSchemeName(operation.security);

      const authScheme = authSchemeName
        ? authSchemes[authSchemeName]
        : undefined;

      operations.push({
        name: parser.getFunctionName(),
        description: parser.getDescription(),
        endpoint: {baseUrl, path, method},
        operation: operation,
        parameters: parser.getParameters(),
        returnValue: parser.getReturnValue(),
        authScheme: authScheme,
      });
    }
  }

  return operations;
}
