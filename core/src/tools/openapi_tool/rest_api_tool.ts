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
import {logger} from '../../utils/logger.js';
import {
  DispatcherRequestInit,
  resolveSslDispatcher,
  SslVerify,
} from '../../utils/ssl_utils.js';
import {isRecord} from '../../utils/type_guards.js';
import {version} from '../../version.js';
import {BaseTool, RunAsyncToolRequest} from '../base_tool.js';
import {credentialToParam, dictToAuthScheme} from './auth/auth_helpers.js';
import type {ApiParameter} from './common/common.js';
import {
  OperationParser,
  OperationParserOptions,
  ToolArgumentsSchema,
} from './openapi_spec_parser/operation_parser.js';
import {ToolAuthHandler} from './openapi_spec_parser/tool_auth_handler.js';

import {
  OperationEndpoint,
  ParsedOperation,
} from './openapi_spec_parser/openapi_spec_parser.js';

/**
 * Gemini rejects a function name of 64 characters or more, so a longer tool
 * name is cut to this length.
 */
const MAX_TOOL_NAME_LENGTH = 60;

/**
 * Issues the API call. It has the shape of the platform `fetch`.
 *
 * `fetch` exposes no certificate-verification option, so this is where a
 * caller reaches a custom certificate authority, a proxy or any other
 * transport setting: wrap `fetch` with a dispatcher that carries the setting
 * and pass the wrapper here.
 */
export type FetchFn = typeof globalThis.fetch;

/** Options accepted by `RestApiTool` and `createRestApiTool`. */
export interface RestApiToolOptions extends OperationParserOptions {
  headerProvider?: (context: ReadonlyContext) => Record<string, string>;
  credentialKey?: string;
  /** Issues the request. Defaults to `globalThis.fetch`. */
  fetchFn?: FetchFn;
  /** TLS certificate verification for the request. */
  sslVerify?: SslVerify;
  /**
   * Whether the constructor parses `operation` into the tool's argument
   * schema. Pass `false` when the operation has already been parsed
   * elsewhere, and install the result with `setOperationParser`.
   */
  shouldParseOperation?: boolean;
}

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
  private fetchFn?: FetchFn;
  private defaultHeaders: Record<string, string> = {};
  private sslVerify?: SslVerify;

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
    options: RestApiToolOptions = {},
  ) {
    super({name: name.slice(0, MAX_TOOL_NAME_LENGTH), description});
    this.endpoint = parseEndpoint(endpoint);
    this.operation = parseOperation(operation);
    this.authCredential = parseAuthCredential(authCredential);
    if (authScheme !== undefined) {
      this.configureAuthScheme(authScheme);
    }
    this.headerProvider = options.headerProvider;
    this.credentialKey = options.credentialKey;
    this.fetchFn = options.fetchFn;
    this.sslVerify = options.sslVerify;
    if (options.shouldParseOperation ?? true) {
      this.operationParser = new OperationParser(this.operation, options);
    }
  }

  /**
   * Sets the security scheme this tool authenticates against.
   *
   * A scheme may arrive as plain data or as JSON text, so it is validated and
   * narrowed here rather than trusted.
   */
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

  /**
   * Sets the credential this tool authenticates with. Passing nothing clears
   * the credential the tool holds.
   */
  @experimental
  public configureAuthCredential(authCredential?: AuthCredential | string) {
    this.authCredential = parseAuthCredential(authCredential);
  }

  @experimental
  public configureCredentialKey(credentialKey: string) {
    this.credentialKey = credentialKey;
  }

  /**
   * Sets the headers this tool sends when the request does not already carry
   * them. The map replaces the map an earlier call set.
   *
   * A default header never replaces a header the request already carries, so
   * it cannot clobber the `Authorization` header set from the exchanged
   * credential.
   *
   * @param headers The default headers.
   */
  @experimental
  public setDefaultHeaders(headers: Record<string, string>) {
    this.defaultHeaders = headers;
  }

  /**
   * Sets TLS certificate verification for this tool's outgoing requests.
   *
   * @param sslVerify The setting. Call with no argument to restore the default
   *     verification against the system CA.
   */
  @experimental
  public configureSslVerify(sslVerify?: SslVerify) {
    this.sslVerify = sslVerify;
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

  /**
   * Returns the JSON schema of the arguments this tool accepts.
   *
   * A tool that wraps this one reads the schema through here, so that
   * `operationParser` stays private.
   */
  @experimental
  public getJsonSchema(): ToolArgumentsSchema {
    return this.requireOperationParser().getJsonSchema();
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
    const schema = this.getJsonSchema();
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

    // The credential travels as one more request parameter, so the location
    // the scheme declares - header, query or cookie - routes it.
    const auth = this.authScheme
      ? credentialToParam(this.authScheme, authResult.authCredential)
      : undefined;

    // Prepare request
    const method = this.endpoint.method.toUpperCase();
    const parameters = this.requireOperationParser().getParameters();
    const argsWithDefaults = applySchemaDefaults(parameters, args);
    const {
      url,
      headers,
      body: parsedBody,
      bodyData,
    } = prepareRequestParams(
      this.endpoint,
      auth ? [...parameters, auth.param] : parameters,
      auth ? {...argsWithDefaults, ...auth.kwargs} : argsWithDefaults,
    );
    // The same URL built without the credential, because an apiKey scheme with
    // `in: query` puts its secret in the URL and the log must not carry it.
    const initialUrl = auth
      ? prepareRequestParams(this.endpoint, parameters, argsWithDefaults).url
      : url;

    // Handle body
    const body = prepareRequestBody(
      this.operation.requestBody,
      parsedBody,
      bodyData,
      headers,
    );

    // The exchanger sets additionalHeaders on the credential it returns, the
    // quota project header for one, so the request must carry them.
    Object.assign(
      headers,
      authResult.authCredential?.http?.additionalHeaders ?? {},
    );

    // Apply dynamic headers from provider
    if (this.headerProvider) {
      const providerHeaders = this.headerProvider(context);
      Object.assign(headers, providerHeaders);
    }

    // Highest priority first: each call fills only what the request still
    // lacks. The credential this tool was configured with, not the one the
    // auth handler resolved, because the handler resolves none when the tool
    // declares no auth scheme.
    addMissingHeaders(headers, this.authCredential?.http?.additionalHeaders);
    addMissingHeaders(headers, {
      'User-Agent': `google-adk/${version} (tool: ${this.name})`,
    });
    // The default headers are last: a default never replaces a header the
    // request already carries.
    addMissingHeaders(headers, this.defaultHeaders);

    const init: DispatcherRequestInit = {
      method,
      headers,
      // eslint-disable-next-line no-undef
      body: body as BodyInit,
    };
    const dispatcher = await resolveSslDispatcher(this.sslVerify);
    if (dispatcher) {
      init.dispatcher = dispatcher;
    }

    const fetchFn: FetchFn =
      this.fetchFn ??
      ((input, requestInit) => globalThis.fetch(input, requestInit));

    try {
      const response = await fetchFn(url, init);

      // The URL as built from the arguments, before the credential is applied,
      // because an apiKey scheme with `in: query` puts its secret in the URL.
      logger.debug(
        `API Response: ${method} ${initialUrl} - Status: ${response.status}`,
      );

      if (!response.ok) {
        const errorDetails = await response.text();
        logger.warn(
          `API call failed for tool ${this.name}: Status ` +
            `${response.status} - ${errorDetails}`,
        );
        // The wording matches adk-python, so a model reads the same advice
        // from either SDK.
        return {
          error:
            `Tool ${this.name} execution failed. Analyze this execution ` +
            'error and your inputs. Retry with adjustments if applicable. ' +
            "But make sure don't retry more than 3 times. Execution Error: " +
            `Status Code: ${response.status}, ${errorDetails}`,
        };
      }

      // The body is read once: a `fetch` body is a single-use stream. The
      // parse needs its own catch, or a plain-text 200 reaches the outer
      // catch and is reported as a transport failure. A non-JSON body still
      // comes back wrapped in a `text` field.
      const bodyText = await response.text();
      try {
        return JSON.parse(bodyText);
      } catch {
        return {text: bodyText};
      }
    } catch (error) {
      return {
        error: `Failed to execute API call: ${(error as Error).message}`,
      };
    }
  }

  /**
   * Renders the tool for a log line or an error message. The credential is
   * left out, so a secret never reaches a log.
   */
  @experimental
  override toString(): string {
    return (
      `RestApiTool(name="${this.name}", description="${this.description}", ` +
      `endpoint="${JSON.stringify(this.endpoint)}")`
    );
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

/**
 * Adds the headers the request does not carry yet, and leaves the ones it
 * does. Names are compared without case, because `fetch` sends both spellings
 * when a record holds two of one header name.
 */
function addMissingHeaders(
  headers: Record<string, string>,
  additions: Record<string, string> = {},
): void {
  const present = new Set(Object.keys(headers).map((key) => key.toLowerCase()));
  for (const [key, value] of Object.entries(additions)) {
    if (!present.has(key.toLowerCase())) {
      headers[key] = value;
      present.add(key.toLowerCase());
    }
  }
}

/**
 * Fills in the schema default of a required parameter the model left out.
 *
 * @param parameters The operation's parameters.
 * @param args The arguments the model supplied.
 * @returns The arguments, with a default added for each omitted one.
 */
function applySchemaDefaults(
  parameters: ApiParameter[],
  args: Record<string, unknown>,
): Record<string, unknown> {
  const filled = {...args};
  for (const parameter of parameters) {
    if (
      parameter.required &&
      !(parameter.name in filled) &&
      parameter.paramSchema?.default !== undefined
    ) {
      filled[parameter.name] = parameter.paramSchema.default;
    }
  }
  return filled;
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
  const cookiePairs: string[] = [];

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
      // A model that has nothing to say for an optional parameter sends null
      // rather than leaving the key out. `?cursor=null` is a value the server
      // reads, so the key is dropped instead. `false`, `0` and `''` are values
      // the model chose, and they survive.
      if (argValue !== null && argValue !== undefined) {
        queryParams.append(originalName, String(argValue));
      }
    } else if (location === 'cookie') {
      cookiePairs.push(`${originalName}=${String(argValue)}`);
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
  // A server URL may end with a slash and the path always starts with one, so
  // the two would join into a double slash. One slash is removed, never every
  // trailing slash, to match adk-python.
  let url = `${endpoint.baseUrl.replace(/\/$/, '')}${resolvedPath}`;

  // A fragment is never sent to the server, and it may itself contain a `?`,
  // so it goes before the query string is read. The generated connector spec
  // appends `#<operation>_<entity>` to keep two operations on one path
  // distinct, and leaving it here folds it into the last query value.
  url = url.split('#')[0];

  const queryStart = url.indexOf('?');
  if (queryStart !== -1) {
    // A parameter the operation declares wins over the one the path template
    // spells out. The declared keys are read up front, so two embedded values
    // for one undeclared key both survive.
    const declaredKeys = new Set(queryParams.keys());
    for (const [key, value] of new URLSearchParams(url.slice(queryStart + 1))) {
      if (!declaredKeys.has(key)) {
        queryParams.append(key, value);
      }
    }
    url = url.slice(0, queryStart);
  }

  // Append query parameters
  const queryString = queryParams.toString();
  if (queryString) {
    url += `?${queryString}`;
  }

  if (cookiePairs.length > 0) {
    headers['Cookie'] = cookiePairs.join('; ');
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
          headers['Content-Type'] = mimeType;
          return new URLSearchParams(finalData as Record<string, string>);
        } else if (mimeType === 'multipart/form-data') {
          const formData = new FormData();
          if (typeof finalData === 'object' && finalData !== null) {
            for (const [key, value] of Object.entries(finalData)) {
              formData.append(key, String(value));
            }
          }
          return formData;
        } else if (mimeType === 'application/octet-stream') {
          headers['Content-Type'] = mimeType;
          return finalData;
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

/**
 * Builds a tool from an operation the spec parser already read.
 *
 * The tool reports the parameters the parser produced, so a renamed or
 * de-duplicated argument name reaches the model unchanged.
 *
 * @param parsed The parsed operation.
 * @param options Options forwarded to the tool.
 * @returns The tool for that operation.
 */
export function createRestApiTool(
  parsed: ParsedOperation,
  options: RestApiToolOptions = {},
): RestApiTool {
  return new RestApiTool(
    parsed.name,
    parsed.description,
    parsed.endpoint,
    parsed.operation,
    parsed.authScheme,
    parsed.authCredential,
    {
      ...options,
      parameters: parsed.parameters,
      returnValue: parsed.returnValue,
    },
  );
}

/**
 * Builds a tool from a serialized `ParsedOperation`.
 *
 * @param parsedOperationJson A JSON document holding one `ParsedOperation`.
 * @throws {Error} If the document does not hold a parsed operation.
 * @returns The tool for that operation.
 */
export function createRestApiToolFromJson(
  parsedOperationJson: string,
): RestApiTool {
  const parsed = JSON.parse(parsedOperationJson) as ParsedOperation;
  // The document reaches this entry point from outside the process, so the
  // shape the type promises is checked rather than assumed.
  if (
    typeof parsed?.name !== 'string' ||
    !Array.isArray(parsed.parameters) ||
    !parsed.endpoint ||
    !parsed.operation
  ) {
    throw new Error(
      'A serialized ParsedOperation needs a name, an endpoint, an operation ' +
        'and a parameters array.',
    );
  }
  return createRestApiTool(parsed);
}
