/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {FunctionDeclaration} from '@google/genai';
import {OpenAPIV3} from 'openapi-types';
import {Context} from '../../agents/context.js';
import {ReadonlyContext} from '../../agents/readonly_context.js';
import {AuthCredential} from '../../auth/auth_credential.js';
import {timeoutErrorName} from '../../utils/error_utils.js';
import {experimental} from '../../utils/experimental.js';
import {getLogger} from '../../utils/logger.js';
import {BaseTool, RunAsyncToolRequest} from '../base_tool.js';
import {applyCredential} from './auth/auth_helpers.js';
import {
  ApiParameter,
  OperationParser,
} from './openapi_spec_parser/operation_parser.js';
import {ToolAuthHandler} from './openapi_spec_parser/tool_auth_handler.js';

import {OperationEndpoint} from './openapi_spec_parser/openapi_spec_parser.js';

export {snakeToLowerCamel} from '../../utils/case_utils.js';

const logger = getLogger();

/**
 * Per-phase budgets, in milliseconds, for one REST API call. Mirrors the
 * `httpx.Timeout` adk-python configures on its default client, so an API is
 * given the same amount of time by either SDK.
 */
export interface RequestTimeout {
  /** Opening the connection. */
  connectMs: number;
  /** Waiting for a connection from the pool. */
  poolMs: number;
  /** Waiting for response bytes. */
  readMs: number;
  /** Sending the request body. */
  writeMs: number;
}

/**
 * Connection setup stays short so an unreachable peer fails fast instead of
 * occupying the invocation; the transfer budgets stay generous, because a
 * legitimate API can be slow. The values match adk-python's `_DEFAULT_TIMEOUT`.
 */
export const DEFAULT_REQUEST_TIMEOUT: RequestTimeout = {
  connectMs: 10_000,
  poolMs: 10_000,
  readMs: 600_000,
  writeMs: 600_000,
};

/** Options accepted by {@link RestApiTool} and {@link createRestApiTool}. */
export interface RestApiToolOptions {
  /** Keeps the operation's property names instead of camelCasing them. */
  preservePropertyNames?: boolean;
  /** Supplies extra request headers for each call. */
  headerProvider?: (context: ReadonlyContext) => Record<string, string>;
  /** Names the slot the tool's credential is stored under. */
  credentialKey?: string;
  /** Overrides part of {@link DEFAULT_REQUEST_TIMEOUT}. */
  timeout?: Partial<RequestTimeout>;
}

/**
 * Merges timeout overrides over {@link DEFAULT_REQUEST_TIMEOUT}.
 *
 * @throws {Error} If a supplied budget is not a finite number above zero.
 */
export function resolveRequestTimeout(
  overrides: Partial<RequestTimeout> = {},
): RequestTimeout {
  const timeout = {...DEFAULT_REQUEST_TIMEOUT, ...overrides};
  for (const [phase, budget] of Object.entries(timeout)) {
    if (!Number.isFinite(budget) || budget <= 0) {
      throw new Error(
        `Invalid request timeout '${phase}': ${budget}. Expected a finite ` +
          `number of milliseconds greater than zero.`,
      );
    }
  }
  return timeout;
}

/**
 * Collapses the four phase budgets into the single deadline `fetch` accepts.
 *
 * `fetch` aborts a whole request rather than one phase of it, so the phases
 * that run in sequence are summed: a call waits for a pooled connection, then
 * opens it, then transfers. Reading and writing overlap, so the larger of the
 * two is taken.
 */
export function requestDeadlineMs(timeout: RequestTimeout): number {
  return (
    timeout.poolMs +
    timeout.connectMs +
    Math.max(timeout.readMs, timeout.writeMs)
  );
}

@experimental
export class RestApiTool extends BaseTool {
  private operationParser: OperationParser;

  private headerProvider?: (context: ReadonlyContext) => Record<string, string>;
  private credentialKey?: string;
  private readonly timeout: RequestTimeout;

  constructor(
    name: string,
    description: string,
    private readonly endpoint: OperationEndpoint,
    private readonly operation: OpenAPIV3.OperationObject,
    private authScheme?: OpenAPIV3.SecuritySchemeObject,
    private authCredential?: AuthCredential,
    options: RestApiToolOptions = {},
  ) {
    super({name, description});
    this.authScheme = authScheme;
    this.authCredential = authCredential;
    this.headerProvider = options.headerProvider;
    this.credentialKey = options.credentialKey;
    this.timeout = resolveRequestTimeout(options.timeout);
    this.operationParser = new OperationParser(operation, options);
  }

  @experimental
  public configureAuthScheme(authScheme: OpenAPIV3.SecuritySchemeObject) {
    this.authScheme = authScheme;
  }

  @experimental
  public configureAuthCredential(authCredential: AuthCredential) {
    this.authCredential = authCredential;
  }

  @experimental
  public configureCredentialKey(credentialKey: string) {
    this.credentialKey = credentialKey;
  }

  @experimental
  override _getDeclaration(): FunctionDeclaration {
    const schema = this.operationParser.getJsonSchema();
    return {
      name: this.name,
      description: this.description,
      parameters: schema,
    };
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
      this.operationParser.getParameters(),
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
        signal: AbortSignal.timeout(requestDeadlineMs(this.timeout)),
      });

      const contentType = response.headers.get('content-type');
      if (contentType && contentType.includes('application/json')) {
        return await response.json();
      } else {
        return await response.text();
      }
    } catch (error: unknown) {
      const timeoutName = timeoutErrorName(error);
      if (timeoutName !== undefined) {
        // An apiKey scheme can put a secret in the query string, so only the
        // path is logged. adk-python logs a URL without a query string too.
        logger.warn(
          `API call timed out for tool ${this.name}: ${method} ` +
            `${url.split('?')[0]}`,
        );
        return {
          error:
            `Tool ${this.name} execution failed. Analyze this execution error` +
            ' and your inputs. Retry with adjustments if applicable. But' +
            " make sure don't retry more than 3 times. Execution Error:" +
            ` Request timed out (${timeoutName}).`,
        };
      }
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
 * Encodes one query value the way adk-python's transport does: a null becomes
 * the empty string and everything else its own string form. Nothing is
 * JSON-encoded, so an object a model passed against the schema is stringified
 * rather than serialized.
 */
function queryValueToString(value: unknown): string {
  return value === null || value === undefined ? '' : String(value);
}

/**
 * Adds one query parameter, matching what adk-python sends.
 *
 * A null or undefined parameter is omitted, because a model routinely sends
 * one for an optional parameter it has no value for and `?cursor=null` is a
 * value the server reads. `false`, `0` and `''` are values the model chose, so
 * they survive. An array repeats the key once per element.
 */
function appendQueryParam(
  queryParams: URLSearchParams,
  name: string,
  value: unknown,
): void {
  if (value === null || value === undefined) {
    return;
  }
  if (Array.isArray(value)) {
    for (const element of value) {
      queryParams.append(name, queryValueToString(element));
    }
    return;
  }
  queryParams.append(name, queryValueToString(value));
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
      appendQueryParam(queryParams, originalName, argValue);
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
  options: RestApiToolOptions = {},
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
