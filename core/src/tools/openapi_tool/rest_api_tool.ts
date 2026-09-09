/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {FunctionDeclaration} from '@google/genai';
import {OpenAPIV3} from 'openapi-types';
import {Context} from '../../agents/context.js';
import {ReadonlyContext} from '../../agents/readonly_context.js';
import {
  AuthCredential,
  parseAuthCredential,
} from '../../auth/auth_credential.js';
import {
  FeatureName,
  isFeatureEnabled,
} from '../../features/feature_registry.js';
import {formatError} from '../../utils/error_utils.js';
import {experimental} from '../../utils/experimental.js';
import {toGeminiSchema} from '../../utils/gemini_schema_util.js';
import {isRecord} from '../../utils/type_guards.js';
import {BaseTool, RunAsyncToolRequest} from '../base_tool.js';
import {applyCredential, dictToAuthScheme} from './auth/auth_helpers.js';
import {
  ApiParameter,
  OperationParser,
} from './openapi_spec_parser/operation_parser.js';
import {ToolAuthHandler} from './openapi_spec_parser/tool_auth_handler.js';

import {OperationEndpoint} from './openapi_spec_parser/openapi_spec_parser.js';

/** The error type a telemetry consumer records for an in-band HTTP failure. */
const HTTP_ERROR_TYPE = 'HTTP_ERROR';

@experimental
export class RestApiTool extends BaseTool {
  private operationParser?: OperationParser;

  private readonly endpoint: OperationEndpoint;
  private readonly operation: OpenAPIV3.OperationObject;
  private authScheme?: OpenAPIV3.SecuritySchemeObject;
  private authCredential?: AuthCredential;
  private headerProvider?: (context: ReadonlyContext) => Record<string, string>;
  private credentialKey?: string;

  constructor(
    name: string,
    description: string,
    endpoint: OperationEndpoint | string,
    operation: OpenAPIV3.OperationObject | string,
    authScheme?:
      | OpenAPIV3.SecuritySchemeObject
      | Record<string, unknown>
      | string,
    authCredential?: AuthCredential | string,
    options: {
      preservePropertyNames?: boolean;
      headerProvider?: (context: ReadonlyContext) => Record<string, string>;
      credentialKey?: string;
      /**
       * Whether the constructor parses `operation` into the tool's argument
       * schema. Pass `false` when the operation has already been parsed
       * elsewhere, and install the result with `setOperationParser`.
       */
      shouldParseOperation?: boolean;
    } = {},
  ) {
    super({name, description});
    this.endpoint = parseEndpoint(endpoint);
    this.operation = parseOperation(operation);
    this.authCredential = parseAuthCredential(authCredential);
    if (authScheme !== undefined) {
      this.configureAuthScheme(authScheme);
    }
    this.headerProvider = options.headerProvider;
    this.credentialKey = options.credentialKey;
    if (options.shouldParseOperation ?? true) {
      this.operationParser = new OperationParser(this.operation, options);
    }
  }

  @experimental
  public configureAuthScheme(
    authScheme:
      | OpenAPIV3.SecuritySchemeObject
      | Record<string, unknown>
      | string,
  ) {
    const data =
      typeof authScheme === 'string'
        ? parseJsonObject(authScheme, 'security scheme')
        : authScheme;
    this.authScheme = dictToAuthScheme(data);
  }

  @experimental
  public configureAuthCredential(authCredential?: AuthCredential | string) {
    this.authCredential = parseAuthCredential(authCredential);
  }

  @experimental
  public configureCredentialKey(credentialKey: string) {
    this.credentialKey = credentialKey;
  }

  /**
   * Installs the operation parser a `shouldParseOperation: false` construction
   * skipped.
   *
   * @param operationParser The parser to use for this tool's arguments.
   */
  @experimental
  public setOperationParser(operationParser: OperationParser) {
    this.operationParser = operationParser;
  }

  /**
   * Classifies a tool result for telemetry.
   *
   * `runAsync` reports a failed call in band, as an object carrying an `error`
   * message, so a caller cannot tell it apart from a successful call without
   * this hook. It never throws, whatever it is given.
   *
   * @param response A value `runAsync` returned.
   * @returns `'HTTP_ERROR'` when the response reports an error, otherwise
   *   `undefined`.
   */
  @experimental
  public detectErrorInResponse(response: unknown): string | undefined {
    if (isRecord(response) && response['error']) {
      return HTTP_ERROR_TYPE;
    }
    return undefined;
  }

  private requireOperationParser(): OperationParser {
    if (!this.operationParser) {
      throw new Error(
        `RestApiTool '${this.name}' has no operation parser. Call ` +
          `setOperationParser() before using the tool.`,
      );
    }
    return this.operationParser;
  }

  @experimental
  override _getDeclaration(): FunctionDeclaration {
    const schema = this.requireOperationParser().getJsonSchema();
    if (isFeatureEnabled(FeatureName.JSON_SCHEMA_FOR_FUNC_DECL)) {
      return {
        name: this.name,
        description: this.description,
        parametersJsonSchema: schema,
      };
    }
    return {
      name: this.name,
      description: this.description,
      parameters: toGeminiSchema(schema),
    };
  }

  /**
   * Renders the tool's identity. Never renders the credential.
   *
   * @returns The tool's name, description and endpoint.
   */
  toString(): string {
    return (
      `RestApiTool(name="${this.name}", description="${this.description}", ` +
      `endpoint="${JSON.stringify(this.endpoint)}")`
    );
  }

  /**
   * Renders the tool for `util.inspect`, a debugger and `console.log`. Never
   * renders the credential.
   *
   * @returns The tool's name, description, endpoint, operation and security
   *   scheme.
   */
  [Symbol.for('nodejs.util.inspect.custom')](): string {
    return (
      `RestApiTool(name="${this.name}", description="${this.description}", ` +
      `endpoint="${JSON.stringify(this.endpoint)}", ` +
      `operation="${JSON.stringify(this.operation)}", ` +
      `authScheme="${JSON.stringify(this.authScheme)}")`
    );
  }

  @experimental
  override async runAsync(request: RunAsyncToolRequest): Promise<unknown> {
    const context = request.toolContext as Context;
    const args = request.args;

    const authHandler = ToolAuthHandler.fromToolContext(
      context,
      this.authScheme,
      this.authCredential,
      {credentialKey: this.credentialKey},
    );

    const authResult = await authHandler.prepareAuthCredentials();
    if (authResult.state === 'pending') {
      return {
        pending: true,
        message: 'Needs your authorization to access your data.',
      };
    }

    const credential = authResult.authCredential;

    // Prepare request
    const method = this.endpoint.method.toUpperCase();
    const {
      url: initialUrl,
      headers,
      body: parsedBody,
      bodyData,
    } = prepareRequestParams(
      this.endpoint,
      this.requireOperationParser().getParameters(),
      args,
    );

    // Handle body
    const body = prepareRequestBody(
      this.operation.requestBody,
      parsedBody,
      bodyData,
      headers,
    );

    // Handle Auth
    const url = applyCredential(
      initialUrl,
      headers,
      credential,
      this.authScheme,
    );

    // Apply dynamic headers from provider
    if (this.headerProvider) {
      const providerHeaders = this.headerProvider(context);
      Object.assign(headers, providerHeaders);
    }

    try {
      const response = await globalThis.fetch(url, {
        method,
        headers,
        // eslint-disable-next-line no-undef
        body: body as BodyInit,
      });

      const contentType = response.headers.get('content-type');
      if (contentType && contentType.includes('application/json')) {
        return await response.json();
      } else {
        return await response.text();
      }
    } catch (error) {
      return {
        error: `Failed to execute API call: ${(error as Error).message}`,
      };
    }
  }
}

export interface PreparedParams {
  url: string;
  headers: Record<string, string>;
  body: unknown;
  bodyData: Record<string, unknown>;
}

/**
 * Parses JSON text that must describe an object.
 *
 * @param value The JSON text.
 * @param owner The name of the parameter, used in the error message.
 * @throws {Error} If the text is not valid JSON or does not describe an
 *   object.
 */
function parseJsonObject(
  value: string,
  owner: string,
): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch (error) {
    throw new Error(`Invalid ${owner}: ${formatError(error)}`);
  }
  if (!isRecord(parsed)) {
    throw new Error(`Invalid ${owner}: expected a JSON object.`);
  }
  return parsed;
}

function requireString(
  source: Record<string, unknown>,
  field: string,
  owner: string,
): string {
  const value = source[field];
  if (typeof value !== 'string') {
    throw new Error(`Invalid ${owner}: '${field}' must be a string.`);
  }
  return value;
}

/**
 * Accepts an endpoint as an object or as the JSON text of one.
 *
 * @param endpoint The endpoint, or its JSON text.
 * @throws {Error} If the text does not describe an object carrying a string
 *   `baseUrl`, `path` and `method`.
 * @returns The endpoint.
 */
function parseEndpoint(
  endpoint: OperationEndpoint | string,
): OperationEndpoint {
  if (typeof endpoint !== 'string') {
    return endpoint;
  }
  const parsed = parseJsonObject(endpoint, 'endpoint');
  return {
    baseUrl: requireString(parsed, 'baseUrl', 'endpoint'),
    path: requireString(parsed, 'path', 'endpoint'),
    method: requireString(parsed, 'method', 'endpoint'),
  };
}

// The narrowing below checks the one field OpenAPI declares required on an
// operation. Everything else the parser reads is optional.
function assertOperation(
  parsed: Record<string, unknown>,
): asserts parsed is Record<string, unknown> & OpenAPIV3.OperationObject {
  if (!isRecord(parsed['responses'])) {
    throw new Error("Invalid operation: 'responses' must be an object.");
  }
}

/**
 * Accepts an operation as an object or as the JSON text of one.
 *
 * @see {@link https://github.com/OAI/OpenAPI-Specification/blob/main/versions/3.1.0.md#operation-object}
 * @param operation The operation, or its JSON text.
 * @throws {Error} If the text does not describe an object carrying an object
 *   `responses`.
 * @returns The operation.
 */
function parseOperation(
  operation: OpenAPIV3.OperationObject | string,
): OpenAPIV3.OperationObject {
  if (typeof operation !== 'string') {
    return operation;
  }
  const parsed = parseJsonObject(operation, 'operation');
  assertOperation(parsed);
  return parsed;
}

/**
 * Percent-encodes a model-supplied value for substitution into a single URL
 * path segment.
 *
 * Path parameter values come from the LLM and are therefore untrusted. Left
 * raw, a `/`, `?` or `#` lets the value escape the segment, and the endpoint,
 * declared by the OpenAPI spec. Values that are exactly `.` or `..` are
 * rejected rather than encoded, because URL normalization resolves a
 * percent-encoded dot-segment (`%2E%2E`) exactly like a literal one.
 *
 * @throws {Error} If the value is a relative path segment.
 */
function encodePathParamValue(name: string, value: string): string {
  if (value === '.' || value === '..') {
    throw new Error(
      `Invalid value for path parameter '${name}': relative path segments ` +
        `('.' and '..') are not allowed.`,
    );
  }
  return encodeURIComponent(value);
}

export function prepareRequestParams(
  endpoint: OperationEndpoint,
  parameters: ApiParameter[],
  args: Record<string, unknown>,
): PreparedParams {
  const headers: Record<string, string> = {};
  const queryParams = new URLSearchParams();
  let body: unknown = undefined;

  const paramsMap = new Map(parameters.map((p) => [p.name, p]));
  const pathParams: Record<string, string> = {};
  const bodyData: Record<string, unknown> = {};

  for (const [argName, argValue] of Object.entries(args)) {
    const param = paramsMap.get(argName);
    if (!param) continue;

    const originalName = param.originalName;
    const location = param.paramLocation;

    if (location === 'path') {
      pathParams[originalName] = encodePathParamValue(
        originalName,
        String(argValue),
      );
    } else if (location === 'query') {
      queryParams.append(originalName, String(argValue));
    } else if (location === 'header') {
      headers[originalName] = String(argValue);
    } else if (location === 'body') {
      if (
        originalName === 'body' ||
        originalName === 'array' ||
        originalName === ''
      ) {
        body = argValue;
      } else {
        bodyData[originalName] = argValue;
      }
    }
  }

  // Placeholders are resolved against the path only, so a path parameter can
  // never reach the host. `hasOwn`, because a spec may name a path parameter
  // `constructor`, which a bare lookup would resolve off Object.prototype.
  const resolvedPath = endpoint.path.replace(
    /\{([^{}]+)\}/g,
    (placeholder, name: string) =>
      Object.hasOwn(pathParams, name) ? pathParams[name] : placeholder,
  );
  let url = `${endpoint.baseUrl}${resolvedPath}`;

  // Extract query parameters from path if any
  const urlParts = url.split('?');
  if (urlParts.length > 1) {
    const pathQueryParams = new URLSearchParams(urlParts[1]);
    for (const [key, value] of pathQueryParams.entries()) {
      queryParams.append(key, value);
    }
    url = urlParts[0];
  }

  // Append query parameters
  const queryString = queryParams.toString();
  if (queryString) {
    url += `?${queryString}`;
  }

  return {url, headers, body, bodyData};
}

export function prepareRequestBody(
  requestBody:
    | OpenAPIV3.RequestBodyObject
    | OpenAPIV3.ReferenceObject
    | undefined,
  body: unknown,
  bodyData: Record<string, unknown>,
  headers: Record<string, string>,
): unknown {
  const finalData =
    body !== undefined
      ? body
      : Object.keys(bodyData).length > 0
        ? bodyData
        : undefined;

  if (requestBody && 'content' in requestBody) {
    const content = requestBody.content;
    for (const [mimeType, _mediaTypeObject] of Object.entries(content)) {
      if (finalData !== undefined) {
        if (mimeType === 'application/json' || mimeType.endsWith('+json')) {
          headers['Content-Type'] = mimeType;
          return typeof finalData === 'string'
            ? finalData
            : JSON.stringify(finalData);
        } else if (mimeType === 'application/x-www-form-urlencoded') {
          return new URLSearchParams(finalData as Record<string, string>);
        } else if (mimeType === 'multipart/form-data') {
          const formData = new FormData();
          if (typeof finalData === 'object' && finalData !== null) {
            for (const [key, value] of Object.entries(finalData)) {
              formData.append(key, String(value));
            }
          }
          return formData;
        } else if (mimeType === 'text/plain') {
          headers['Content-Type'] = mimeType;
          return String(finalData);
        }
      }
      break; // Process only the first mime type
    }
  } else if (finalData !== undefined) {
    // Fallback to JSON if no requestBody content specified but data exists
    headers['Content-Type'] = 'application/json';
    return typeof finalData === 'string'
      ? finalData
      : JSON.stringify(finalData);
  }
  return undefined;
}

export function createRestApiTool(
  parsed: {
    name: string;
    description: string;
    endpoint: OperationEndpoint;
    operation: OpenAPIV3.OperationObject;
    authScheme?: OpenAPIV3.SecuritySchemeObject;
  },
  options: {
    preservePropertyNames?: boolean;
    headerProvider?: (context: ReadonlyContext) => Record<string, string>;
    credentialKey?: string;
  } = {},
): RestApiTool {
  return new RestApiTool(
    parsed.name,
    parsed.description,
    parsed.endpoint,
    parsed.operation,
    parsed.authScheme,
    undefined,
    options,
  );
}
