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
import {experimental} from '../../utils/experimental.js';
import {BaseTool, RunAsyncToolRequest} from '../base_tool.js';
import {applyCredential} from './auth/auth_helpers.js';
import {
  ApiParameter,
  OperationParser,
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

/** Options accepted by `RestApiTool` and `createRestApiTool`. */
export interface RestApiToolOptions {
  preservePropertyNames?: boolean;
  headerProvider?: (context: ReadonlyContext) => Record<string, string>;
  credentialKey?: string;
  /**
   * Reports the operation's parameters instead of a parser built from
   * `operation`. Use it to carry over parameters that are already parsed.
   */
  operationParser?: OperationParser;
}

@experimental
export class RestApiTool extends BaseTool {
  private operationParser: OperationParser;

  private headerProvider?: (context: ReadonlyContext) => Record<string, string>;
  private credentialKey?: string;

  constructor(
    name: string,
    description: string,
    private readonly endpoint: OperationEndpoint,
    private readonly operation: OpenAPIV3.OperationObject,
    private authScheme?: OpenAPIV3.SecuritySchemeObject,
    private authCredential?: AuthCredential,
    options: RestApiToolOptions = {},
  ) {
    super({name: name.slice(0, MAX_TOOL_NAME_LENGTH), description});
    this.authScheme = authScheme;
    this.authCredential = authCredential;
    this.headerProvider = options.headerProvider;
    this.credentialKey = options.credentialKey;
    this.operationParser =
      options.operationParser ?? new OperationParser(operation, options);
  }

  @experimental
  public configureAuthScheme(authScheme: OpenAPIV3.SecuritySchemeObject) {
    this.authScheme = authScheme;
  }

  /**
   * Sets the credential this tool authenticates with. Passing nothing clears
   * the credential the tool holds.
   */
  @experimental
  public configureAuthCredential(authCredential?: AuthCredential) {
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
      });

      const contentType = response.headers.get('content-type');
      if (contentType && contentType.includes('application/json')) {
        return await response.json();
      }
      return {text: await response.text()};
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

  // A fragment is never sent to the server, and it may itself contain a `?`,
  // so it goes before the query string is read.
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
      operationParser: OperationParser.load(
        parsed.operation,
        parsed.parameters,
        {
          preservePropertyNames: options.preservePropertyNames,
        },
      ),
    },
  );
}

/**
 * Builds a tool from a serialized `ParsedOperation`.
 *
 * @param parsedOperationJson A JSON document holding one `ParsedOperation`.
 * @returns The tool for that operation.
 */
export function createRestApiToolFromJson(
  parsedOperationJson: string,
): RestApiTool {
  return createRestApiTool(JSON.parse(parsedOperationJson) as ParsedOperation);
}
