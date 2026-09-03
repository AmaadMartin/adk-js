/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {OpenAPIV3} from 'openapi-types';
import {experimental} from '../../utils/experimental.js';
import {logger} from '../../utils/logger.js';
import {
  loadDefaultClientCerts,
  useClientCertEffective,
} from '../../utils/mtls_utils.js';
import {
  DiscoveryDocument,
  DiscoveryMethod,
  DiscoveryParameter,
  DiscoveryResource,
  DiscoverySchema,
  fetchDiscoveryDocument,
} from './discovery_document.js';

const SCHEMA_REF_PREFIX = '#/components/schemas/';

const OAUTH2_AUTHORIZATION_URL = 'https://accounts.google.com/o/oauth2/auth';
const OAUTH2_TOKEN_URL = 'https://oauth2.googleapis.com/token';

/**
 * The alternatives that stand in for Discovery's `any` type, which OpenAPI 3.0
 * has no direct equivalent of.
 *
 * Every member must constrain the value. `oneOf` means exactly one match, so an
 * unconstrained member matches everything and pushes every other value to two
 * matches, which rejects it. That rules out `{nullable: true}` for the null
 * alternative, because `nullable` without a `type` constrains nothing.
 * `{enum: [null]}` admits null alone and is the OpenAPI 3.0 spelling of the
 * `{type: 'null'}` that adk-python emits; both accept the same values.
 */
const ANY_TYPE_ONE_OF: OpenAPIV3.SchemaObject[] = [
  {type: 'object'},
  {type: 'array', items: {}},
  {type: 'string'},
  {type: 'number'},
  {type: 'boolean'},
  {enum: [null]},
];

/** The error responses every converted operation declares. */
const ERROR_RESPONSE_DESCRIPTIONS: Readonly<Record<string, string>> = {
  '400': 'Bad request',
  '401': 'Unauthorized',
  '403': 'Forbidden',
  '404': 'Not found',
  '500': 'Server error',
};

/** The schema types OpenAPI 3.0 accepts outside of an array schema. */
const NON_ARRAY_SCHEMA_TYPES = [
  'boolean',
  'object',
  'number',
  'string',
  'integer',
] as const;

/** The HTTP verbs an OpenAPI path item can carry an operation for. */
const HTTP_METHODS = [
  'get',
  'put',
  'post',
  'delete',
  'options',
  'head',
  'patch',
  'trace',
] as const;

type HttpMethod = (typeof HTTP_METHODS)[number];

/**
 * Narrows a Discovery type string to a non-array OpenAPI schema type.
 *
 * Discovery's vocabulary is `any | array | boolean | integer | number |
 * object | string`; `any` and `array` are handled by their own branches, so
 * only a type outside the vocabulary fails to narrow and yields a schema
 * with no `type`.
 */
function toNonArraySchemaType(
  type: string | undefined,
): OpenAPIV3.NonArraySchemaObjectType | undefined {
  return NON_ARRAY_SCHEMA_TYPES.find((candidate) => candidate === type);
}

/** Narrows an HTTP verb string to one an OpenAPI path item can hold. */
function toHttpMethod(method: string): HttpMethod | undefined {
  return HTTP_METHODS.find((candidate) => candidate === method);
}

/** Rewrites a Discovery `$ref` into an OpenAPI components reference. */
function toComponentsRef(ref: string): string {
  // Concatenation rather than String.replace, so a `$` in the reference
  // cannot be expanded as a replacement pattern.
  return ref.startsWith('#')
    ? SCHEMA_REF_PREFIX + ref.slice(1)
    : SCHEMA_REF_PREFIX + ref;
}

/**
 * Converts the top-level API metadata of a Discovery document.
 *
 * @param doc The Discovery document.
 * @param apiName The Discovery API id, used as the title fallback.
 * @param apiVersion The API version, used as the version fallback.
 * @return The OpenAPI `info` object.
 */
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

/**
 * Converts the Discovery documentation link into an OpenAPI `externalDocs`
 * object, or `undefined` when the document declares no link.
 */
export function convertExternalDocs(
  doc: DiscoveryDocument,
): OpenAPIV3.ExternalDocumentationObject | undefined {
  if (!doc.documentationLink) {
    return undefined;
  }
  return {description: 'API Documentation', url: doc.documentationLink};
}

/**
 * Converts the Discovery root URL and service path into an OpenAPI server
 * list.
 *
 * @param doc The Discovery document.
 * @param apiName The Discovery API id, used in the server description.
 * @param apiVersion The API version, used in the server description.
 * @param useClientCert Whether the caller asked for a client certificate. The
 *     mutual-TLS root URL is selected on this flag alone, matching adk-python:
 *     it does not depend on a certificate having loaded.
 */
export function convertServers(
  doc: DiscoveryDocument,
  apiName: string,
  apiVersion: string,
  useClientCert = false,
): OpenAPIV3.ServerObject[] {
  const rootUrl =
    useClientCert && doc.mtlsRootUrl ? doc.mtlsRootUrl : (doc.rootUrl ?? '');

  let url = rootUrl + (doc.servicePath ?? '');
  if (url.endsWith('/')) {
    url = url.slice(0, -1);
  }
  return [{url, description: `${apiName} ${apiVersion} API`}];
}

/**
 * Converts the Discovery auth block into OpenAPI security schemes plus the
 * document-level security requirement.
 *
 * The `apiKey` scheme is always emitted because most Google APIs accept one.
 */
export function convertSecuritySchemes(doc: DiscoveryDocument): {
  securitySchemes: Record<string, OpenAPIV3.SecuritySchemeObject>;
  security: OpenAPIV3.SecurityRequirementObject[];
} {
  const securitySchemes: Record<string, OpenAPIV3.SecuritySchemeObject> = {};
  const oauth2 = doc.auth?.oauth2;
  let scopeNames: string[] = [];

  if (oauth2) {
    const scopes: Record<string, string> = {};
    for (const [scope, scopeInfo] of Object.entries(oauth2.scopes ?? {})) {
      scopes[scope] = scopeInfo.description ?? '';
    }
    scopeNames = Object.keys(scopes);
    securitySchemes['oauth2'] = {
      type: 'oauth2',
      description: 'OAuth 2.0 authentication',
      flows: {
        authorizationCode: {
          authorizationUrl: OAUTH2_AUTHORIZATION_URL,
          tokenUrl: OAUTH2_TOKEN_URL,
          scopes,
        },
      },
    };
  }

  securitySchemes['apiKey'] = {
    type: 'apiKey',
    in: 'query',
    name: 'key',
    description: 'API key for accessing this API',
  };

  return {
    securitySchemes,
    security: [oauth2 ? {oauth2: scopeNames} : {}, {apiKey: []}],
  };
}

/**
 * A converted schema, which may carry a `$ref` beside its own keywords.
 *
 * Discovery states a `description`, a `format` or a `type` next to a `$ref`,
 * and the converter keeps both halves so no documentation is lost. That is why
 * the emitted schema is wider than `OpenAPIV3.ReferenceObject`, which admits
 * `$ref` alone.
 */
export type ConvertedSchema = OpenAPIV3.SchemaObject & {$ref?: string};

/** Converts every named schema in the Discovery document. */
export function convertSchemas(
  doc: DiscoveryDocument,
): Record<string, ConvertedSchema> {
  const schemas: Record<string, ConvertedSchema> = {};
  for (const [name, schemaDef] of Object.entries(doc.schemas ?? {})) {
    schemas[name] = convertSchemaObject(schemaDef);
  }
  return schemas;
}

/** Converts the type-specific half of a Discovery schema definition. */
function convertSchemaType(schemaDef: DiscoverySchema): OpenAPIV3.SchemaObject {
  if (schemaDef.type === 'object') {
    const schema: OpenAPIV3.NonArraySchemaObject = {type: 'object'};
    if (schemaDef.properties) {
      const properties: Record<
        string,
        OpenAPIV3.SchemaObject | OpenAPIV3.ReferenceObject
      > = {};
      const required: string[] = [];
      for (const [name, propDef] of Object.entries(schemaDef.properties)) {
        properties[name] = convertSchemaObject(propDef);
        if (propDef.required) {
          required.push(name);
        }
      }
      schema.properties = properties;
      if (required.length > 0) {
        schema.required = required;
      }
    }
    return schema;
  }

  if (schemaDef.type === 'array') {
    // `items` is mandatory on an OpenAPI array schema. The empty schema
    // accepts anything, which is what a Discovery array without `items` means.
    return {
      type: 'array',
      items: schemaDef.items ? convertSchemaObject(schemaDef.items) : {},
    };
  }

  if (schemaDef.type === 'any') {
    return {oneOf: ANY_TYPE_ONE_OF};
  }

  const type = toNonArraySchemaType(schemaDef.type);
  return type ? {type} : {};
}

/**
 * Copies the constraint keys Discovery and OpenAPI spell the same way.
 *
 * `description` is not among them: Discovery puts a parameter's description on
 * the parameter rather than on its schema.
 */
function applyFacets(
  schema: OpenAPIV3.SchemaObject,
  def: DiscoverySchema,
): void {
  if (def.format !== undefined) {
    schema.format = def.format;
  }
  if (def.enum !== undefined) {
    schema.enum = def.enum;
  }
  if (def.pattern !== undefined) {
    schema.pattern = def.pattern;
  }
  if (def.default !== undefined) {
    schema.default = def.default;
  }
}

/**
 * Recursively converts one Discovery schema definition into an OpenAPI schema.
 *
 * The `$ref` is copied independently of the type branch, so a definition that
 * states both a reference and its own keywords keeps both. Dropping the
 * siblings would lose the only description Discovery gives many fields.
 */
export function convertSchemaObject(
  schemaDef: DiscoverySchema,
): ConvertedSchema {
  const schema: ConvertedSchema = convertSchemaType(schemaDef);
  if (schemaDef.$ref) {
    schema.$ref = toComponentsRef(schemaDef.$ref);
  }

  applyFacets(schema, schemaDef);
  if (schemaDef.description !== undefined) {
    schema.description = schemaDef.description;
  }

  return schema;
}

/**
 * Recursively converts every resource and nested resource into path entries.
 *
 * @param resources The Discovery resource map.
 * @param paths The paths object to populate, mutated in place.
 */
export function convertResources(
  resources: Record<string, DiscoveryResource>,
  paths: OpenAPIV3.PathsObject,
): void {
  for (const resource of Object.values(resources)) {
    convertMethods(resource.methods ?? {}, paths);
    convertResources(resource.resources ?? {}, paths);
  }
}

/**
 * Converts a Discovery method map into path entries.
 *
 * The path comes from each method's `flatPath`, which is preferred over `path`
 * because the latter may carry reserved-expansion variables such as
 * `{+projectId}`.
 *
 * @param methods The Discovery method map.
 * @param paths The paths object to populate, mutated in place.
 */
export function convertMethods(
  methods: Record<string, DiscoveryMethod>,
  paths: OpenAPIV3.PathsObject,
): void {
  for (const [name, method] of Object.entries(methods)) {
    const verb = method.httpMethod ?? 'GET';
    const httpMethod = toHttpMethod(verb.toLowerCase());
    if (!httpMethod) {
      logger.warn(
        `Skipping discovery method '${name}': '${verb}' is not an HTTP verb ` +
          'an OpenAPI path item can describe.',
      );
      continue;
    }

    let restPath = method.flatPath ?? method.path ?? '/';
    if (!restPath.startsWith('/')) {
      restPath = '/' + restPath;
    }

    const pathItem = paths[restPath] ?? {};
    paths[restPath] = pathItem;
    pathItem[httpMethod] = convertOperation(
      method,
      extractPathParameters(restPath),
    );
  }
}

/**
 * Extracts the `{name}` path parameters from a URL path.
 *
 * A segment only counts when it is entirely a placeholder, so
 * `v1/documents/{documentId}:batchUpdate` yields no parameters — the trailing
 * `:batchUpdate` verb makes that segment more than a placeholder. Such a
 * parameter still reaches the operation through the declared-parameter list.
 */
export function extractPathParameters(path: string): string[] {
  return path
    .split('/')
    .filter((segment) => segment.startsWith('{') && segment.endsWith('}'))
    .map((segment) => segment.slice(1, -1));
}

/** Builds the response set of one operation. */
function createResponses(responseRef?: string): OpenAPIV3.ResponsesObject {
  const successResponse: OpenAPIV3.ResponseObject = {
    description: 'Successful operation',
  };
  if (responseRef) {
    successResponse.content = {
      'application/json': {schema: {$ref: toComponentsRef(responseRef)}},
    };
  }

  const responses: OpenAPIV3.ResponsesObject = {'200': successResponse};
  for (const [status, description] of Object.entries(
    ERROR_RESPONSE_DESCRIPTIONS,
  )) {
    responses[status] = {description};
  }
  return responses;
}

/** Converts one Discovery method into an OpenAPI operation. */
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

  const operation: OpenAPIV3.OperationObject = {
    operationId: method.id ?? '',
    summary: method.description ?? '',
    description: method.description ?? '',
    parameters,
    responses: createResponses(method.response?.$ref),
  };

  if (method.request?.$ref) {
    operation.requestBody = {
      description: 'Request body',
      content: {
        'application/json': {
          schema: {$ref: toComponentsRef(method.request.$ref)},
        },
      },
      required: true,
    };
  }

  if (method.scopes && method.scopes.length > 0) {
    operation.security = [{oauth2: method.scopes}];
  }

  return operation;
}

/** Converts a declared Discovery parameter into an OpenAPI schema. */
export function convertParameterSchema(
  param: DiscoveryParameter,
): OpenAPIV3.SchemaObject {
  // Only the type is taken from the parameter: Discovery never nests
  // properties under a parameter, and neither does the reference converter.
  const schema = convertSchemaType({type: param.type ?? 'string'});
  applyFacets(schema, param);

  return schema;
}

/**
 * Converts a whole Google API Discovery document into an OpenAPI 3.0 document.
 *
 * @param doc The Discovery document.
 * @param apiName The Discovery API id, e.g. `calendar`.
 * @param apiVersion The API version, e.g. `v3`.
 * @param options.useClientCert Whether to prefer the document's mutual-TLS
 *     root URL for the server entry.
 * @return The equivalent OpenAPI 3.0 document.
 */
export function convertDiscoveryDocument(
  doc: DiscoveryDocument,
  apiName: string,
  apiVersion: string,
  options: {useClientCert?: boolean} = {},
): OpenAPIV3.Document {
  const paths: OpenAPIV3.PathsObject = {};
  convertResources(doc.resources ?? {}, paths);
  convertMethods(doc.methods ?? {}, paths);

  const {securitySchemes, security} = convertSecuritySchemes(doc);

  const document: OpenAPIV3.Document = {
    openapi: '3.0.0',
    info: convertInfo(doc, apiName, apiVersion),
    servers: convertServers(doc, apiName, apiVersion, options.useClientCert),
    paths,
    components: {schemas: convertSchemas(doc), securitySchemes},
    security,
  };

  const externalDocs = convertExternalDocs(doc);
  if (externalDocs) {
    document.externalDocs = externalDocs;
  }

  return document;
}

/**
 * Converts a Google API Discovery document to an OpenAPI 3.0 document.
 *
 * The document is fetched once, on the first `convert()`.
 *
 * @example
 * ```ts
 * const converter = new GoogleApiToOpenApiConverter('calendar', 'v3');
 * const spec = await converter.convert();
 * ```
 *
 * Set `GOOGLE_API_USE_CLIENT_CERTIFICATE=true` to present the SecureConnect
 * client certificate. The converter then reads the discovery document from
 * `www.mtls.googleapis.com` and prefers the document's `mtlsRootUrl` server.
 */
@experimental
export class GoogleApiToOpenApiConverter {
  private readonly discoveryUrl?: string;
  private readonly useClientCert: boolean;
  private googleApiSpec?: DiscoveryDocument;

  /**
   * @param apiName The Discovery API id, e.g. `calendar`.
   * @param apiVersion The API version, e.g. `v3`.
   * @param options.discoveryUrl An alternative Discovery URL template.
   */
  constructor(
    private readonly apiName: string,
    private readonly apiVersion: string,
    options: {discoveryUrl?: string} = {},
  ) {
    this.discoveryUrl = options.discoveryUrl;
    // Captured once, so changing the environment mid-conversion cannot make
    // the fetched document and the emitted servers disagree.
    this.useClientCert = useClientCertEffective();
  }

  /** Fetches the Discovery document if needed, and converts it. */
  @experimental
  async convert(): Promise<OpenAPIV3.Document> {
    const doc = this.googleApiSpec ?? (await this.fetchDocument());
    this.googleApiSpec = doc;
    return convertDiscoveryDocument(doc, this.apiName, this.apiVersion, {
      useClientCert: this.useClientCert,
    });
  }

  private async fetchDocument(): Promise<DiscoveryDocument> {
    const certs = this.useClientCert
      ? await loadDefaultClientCerts()
      : undefined;
    return fetchDiscoveryDocument(this.apiName, this.apiVersion, {
      discoveryUrl: this.discoveryUrl,
      certs,
    });
  }
}
