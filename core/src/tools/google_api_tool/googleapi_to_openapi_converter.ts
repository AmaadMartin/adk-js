/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type {OpenAPIV3} from 'openapi-types';
import {experimental} from '../../utils/experimental.js';
import {
  DiscoveryDocument,
  DiscoveryMethod,
  DiscoveryParameter,
  DiscoveryResource,
  DiscoverySchema,
  fetchDiscoveryDocument,
} from './discovery_document.js';

const AUTHORIZATION_URL = 'https://accounts.google.com/o/oauth2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const SCHEMA_REF_PREFIX = '#/components/schemas/';

export type ConvertedSchema = OpenAPIV3.SchemaObject & {$ref?: string};

/**
 * The OpenAPI 3.0 verbs, as literals rather than `Object.values(HttpMethods)`.
 * `openapi-types` is a devDependency, so reading its enum at runtime would emit
 * a `require` and break every consumer of the published package. The element
 * type still comes from the enum, so a typo here fails the build.
 */
const HTTP_METHODS: ReadonlyArray<`${OpenAPIV3.HttpMethods}`> = [
  'get',
  'put',
  'post',
  'delete',
  'options',
  'head',
  'patch',
  'trace',
];

function isHttpMethod(value: string): value is OpenAPIV3.HttpMethods {
  return HTTP_METHODS.some((method) => method === value);
}

function toSchemaRef(ref: string): string {
  return ref.startsWith('#')
    ? ref.replace('#', SCHEMA_REF_PREFIX)
    : SCHEMA_REF_PREFIX + ref;
}

export function convertInfo(
  doc: DiscoveryDocument,
  apiName: string,
  apiVersion: string,
): OpenAPIV3.InfoObject {
  return {
    title: doc.title ?? `${apiName} API`,
    description: doc.description ?? '',
    version: doc.version ?? apiVersion,
    contact: {},
    termsOfService: doc.documentationLink ?? '',
  };
}

export function convertExternalDocs(
  doc: DiscoveryDocument,
): OpenAPIV3.ExternalDocumentationObject | undefined {
  if (doc.documentationLink === undefined) {
    return undefined;
  }
  return {description: 'API Documentation', url: doc.documentationLink};
}

export function convertServers(
  doc: DiscoveryDocument,
  apiName: string,
  apiVersion: string,
): OpenAPIV3.ServerObject[] {
  let url = (doc.rootUrl ?? '') + (doc.servicePath ?? '');
  if (url.endsWith('/')) {
    url = url.slice(0, -1);
  }
  return [{url, description: `${apiName} ${apiVersion} API`}];
}

export function convertSecuritySchemes(doc: DiscoveryDocument): {
  securitySchemes: Record<string, OpenAPIV3.SecuritySchemeObject>;
  security: OpenAPIV3.SecurityRequirementObject[];
} {
  const securitySchemes: Record<string, OpenAPIV3.SecuritySchemeObject> = {};
  const security: OpenAPIV3.SecurityRequirementObject[] = [];
  const discoveryScopes = doc.auth?.oauth2?.scopes;

  if (discoveryScopes !== undefined) {
    const scopes: Record<string, string> = {};
    for (const [scope, info] of Object.entries(discoveryScopes)) {
      scopes[scope] = info.description ?? '';
    }
    securitySchemes['oauth2'] = {
      type: 'oauth2',
      description: 'OAuth 2.0 authentication',
      flows: {
        authorizationCode: {
          authorizationUrl: AUTHORIZATION_URL,
          tokenUrl: TOKEN_URL,
          scopes,
        },
      },
    };
    security.push({oauth2: Object.keys(scopes)});
  } else {
    security.push({});
  }

  securitySchemes['apiKey'] = {
    type: 'apiKey',
    in: 'query',
    name: 'key',
    description: 'API key for accessing this API',
  };
  security.push({apiKey: []});

  return {securitySchemes, security};
}

export function convertSchemas(
  doc: DiscoveryDocument,
): Record<string, ConvertedSchema> {
  const schemas: Record<string, ConvertedSchema> = {};
  for (const [name, definition] of Object.entries(doc.schemas ?? {})) {
    schemas[name] = convertSchemaObject(definition);
  }
  return schemas;
}

export function convertSchemaObject(
  schemaDef: DiscoverySchema,
): ConvertedSchema {
  const common: OpenAPIV3.BaseSchemaObject & {$ref?: string} = {};
  if (schemaDef.$ref !== undefined) {
    common.$ref = toSchemaRef(schemaDef.$ref);
  }
  if (schemaDef.format !== undefined) {
    common.format = schemaDef.format;
  }
  if (schemaDef.enum !== undefined) {
    common.enum = schemaDef.enum;
  }
  if (schemaDef.description !== undefined) {
    common.description = schemaDef.description;
  }
  if (schemaDef.pattern !== undefined) {
    common.pattern = schemaDef.pattern;
  }
  if (schemaDef.default !== undefined) {
    common.default = schemaDef.default;
  }

  switch (schemaDef.type) {
    case undefined:
      return common;
    case 'object': {
      const properties: Record<string, ConvertedSchema> = {};
      const required: string[] = [];
      for (const [name, definition] of Object.entries(
        schemaDef.properties ?? {},
      )) {
        properties[name] = convertSchemaObject(definition);
        if (definition.required === true) {
          required.push(name);
        }
      }
      return {
        ...common,
        type: 'object',
        ...(schemaDef.properties === undefined ? {} : {properties}),
        ...(required.length === 0 ? {} : {required}),
      };
    }
    case 'array':
      return {
        ...common,
        type: 'array',
        items:
          schemaDef.items === undefined
            ? {}
            : convertSchemaObject(schemaDef.items),
      };
    case 'any':
      return {
        ...common,
        oneOf: [
          {type: 'object'},
          {type: 'array', items: {}},
          {type: 'string'},
          {type: 'number'},
          {type: 'boolean'},
        ],
      };
    case 'boolean':
    case 'integer':
    case 'number':
    case 'string':
      return {...common, type: schemaDef.type};
    default:
      // simplicity: OpenAPI 3.0 has a closed set of type names, so a Discovery
      // type outside it is dropped rather than emitted as an invalid schema.
      // Upgrade path: map it explicitly once a real API needs one.
      return common;
  }
}

export function convertResources(
  resources: Record<string, DiscoveryResource>,
  paths: OpenAPIV3.PathsObject,
): void {
  for (const resource of Object.values(resources)) {
    convertMethods(resource.methods ?? {}, paths);
    if (resource.resources !== undefined) {
      convertResources(resource.resources, paths);
    }
  }
}

export function convertMethods(
  methods: Record<string, DiscoveryMethod>,
  paths: OpenAPIV3.PathsObject,
): void {
  for (const method of Object.values(methods)) {
    const httpMethod = (method.httpMethod ?? 'GET').toLowerCase();
    let restPath = method.flatPath ?? method.path ?? '/';
    if (!restPath.startsWith('/')) {
      restPath = '/' + restPath;
    }
    if (!isHttpMethod(httpMethod)) {
      continue;
    }
    const pathItem = paths[restPath] ?? {};
    paths[restPath] = pathItem;
    pathItem[httpMethod] = convertOperation(
      method,
      extractPathParameters(restPath),
    );
  }
}

export function extractPathParameters(path: string): string[] {
  return path
    .split('/')
    .filter((segment) => segment.startsWith('{') && segment.endsWith('}'))
    .map((segment) => segment.slice(1, -1));
}

export function convertOperation(
  method: DiscoveryMethod,
  pathParams: string[],
): OpenAPIV3.OperationObject {
  const parameters: OpenAPIV3.ParameterObject[] = pathParams.map((name) => ({
    name,
    in: 'path',
    required: true,
    schema: {type: 'string'},
  }));

  for (const [name, param] of Object.entries(method.parameters ?? {})) {
    if (pathParams.includes(name)) {
      continue;
    }
    parameters.push({
      name,
      in: param.location ?? 'query',
      description: param.description ?? '',
      required: param.required ?? false,
      schema: convertParameterSchema(param),
    });
  }

  const responses: OpenAPIV3.ResponsesObject = {
    '200': {description: 'Successful operation'},
    '400': {description: 'Bad request'},
    '401': {description: 'Unauthorized'},
    '403': {description: 'Forbidden'},
    '404': {description: 'Not found'},
    '500': {description: 'Server error'},
  };

  const responseRef = method.response?.$ref;
  if (responseRef !== undefined) {
    responses['200'] = {
      description: 'Successful operation',
      content: {
        'application/json': {schema: {$ref: toSchemaRef(responseRef)}},
      },
    };
  }

  const operation: OpenAPIV3.OperationObject = {
    operationId: method.id ?? '',
    summary: method.description ?? '',
    description: method.description ?? '',
    parameters,
    responses,
  };

  const requestRef = method.request?.$ref;
  if (requestRef !== undefined) {
    operation.requestBody = {
      description: 'Request body',
      content: {'application/json': {schema: {$ref: toSchemaRef(requestRef)}}},
      required: true,
    };
  }

  if (method.scopes !== undefined && method.scopes.length > 0) {
    operation.security = [{oauth2: method.scopes}];
  }

  return operation;
}

export function convertParameterSchema(
  param: DiscoveryParameter,
): OpenAPIV3.SchemaObject {
  // A Discovery parameter is always inline, so the result never carries `$ref`.
  return convertSchemaObject({
    type: param.type ?? 'string',
    enum: param.enum,
    format: param.format,
    default: param.default,
    pattern: param.pattern,
  });
}

export function convertDiscoveryDocument(
  doc: DiscoveryDocument,
  apiName: string,
  apiVersion: string,
): OpenAPIV3.Document {
  const {securitySchemes, security} = convertSecuritySchemes(doc);
  const paths: OpenAPIV3.PathsObject = {};
  convertResources(doc.resources ?? {}, paths);
  convertMethods(doc.methods ?? {}, paths);

  const document: OpenAPIV3.Document = {
    openapi: '3.0.0',
    info: convertInfo(doc, apiName, apiVersion),
    servers: convertServers(doc, apiName, apiVersion),
    paths,
    components: {schemas: convertSchemas(doc), securitySchemes},
    security,
  };

  const externalDocs = convertExternalDocs(doc);
  if (externalDocs !== undefined) {
    document.externalDocs = externalDocs;
  }
  return document;
}

/**
 * Converts a Google API Discovery document into an OpenAPI 3.0 document, so
 * that `OpenAPIToolset` can turn a Google REST API into a set of tools.
 */
@experimental
export class GoogleApiToOpenApiConverter {
  constructor(
    private readonly apiName: string,
    private readonly apiVersion: string,
  ) {}

  async convert(): Promise<OpenAPIV3.Document> {
    const doc = await fetchDiscoveryDocument(this.apiName, this.apiVersion);
    return convertDiscoveryDocument(doc, this.apiName, this.apiVersion);
  }
}
