/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {OpenAPIV3} from 'openapi-types';
import {experimental} from '../../../utils/experimental.js';
import {
  ApiParameter,
  createApiParameter,
  generateParamDoc,
  generateReturnDoc,
  getTypeHint,
  normalizeSchema,
  toSnakeCaseName,
} from '../common/common.js';

/** Accepts the JSON form of an operation, as adk-python's parser does. */
function readOperation(
  operation: OpenAPIV3.OperationObject | string,
): OpenAPIV3.OperationObject {
  if (typeof operation !== 'string') {
    return operation;
  }
  const parsed: unknown = JSON.parse(operation);
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('Operation must be a JSON object');
  }
  return parsed as OpenAPIV3.OperationObject;
}

/**
 * Parses an OpenAPI OperationObject and extracts its parameters, request body, and return value.
 *
 * It maps OpenAPI parameters and request bodies into a flat list of `ApiParameter` objects
 * that are compatible with Gemini's tool function declarations.
 */
@experimental
export class OperationParser {
  private params: ApiParameter[] = [];
  private returnValue?: ApiParameter;
  private preservePropertyNames: boolean;
  private readonly operation: OpenAPIV3.OperationObject;

  constructor(
    operation: OpenAPIV3.OperationObject | string,
    options: {preservePropertyNames?: boolean; shouldParse?: boolean} = {},
  ) {
    this.operation = readOperation(operation);
    this.preservePropertyNames = options.preservePropertyNames ?? false;
    if (options.shouldParse ?? true) {
      this.processOperationParameters();
      this.processRequestBody();
      this.processReturnValue();
      this.dedupeParamNames();
    }
  }

  /**
   * Builds a parser over parameters that were parsed elsewhere.
   *
   * @param operation The operation the parameters came from.
   * @param params The parameters to carry.
   * @param returnValue The return value to carry.
   * @param options How the parser reads names.
   * @returns A parser that reports the supplied parameters.
   */
  @experimental
  static load(
    operation: OpenAPIV3.OperationObject | string,
    params: ApiParameter[],
    returnValue?: ApiParameter,
    options: {preservePropertyNames?: boolean} = {},
  ): OperationParser {
    const parser = new OperationParser(operation, {
      ...options,
      shouldParse: false,
    });
    parser.params = params;
    parser.returnValue = returnValue;
    return parser;
  }

  private getParamName(originalName: string): string {
    if (this.preservePropertyNames) {
      return originalName;
    }
    return toSnakeCaseName(originalName);
  }

  private processOperationParameters() {
    const parameters = this.operation.parameters || [];
    for (const param of parameters) {
      // Assume resolved references for now
      if ('name' in param) {
        const originalName = param.name;
        const description = param.description || '';
        const schema = normalizeSchema(
          param.schema,
          `operation parameter '${originalName}'`,
        );
        this.params.push(
          createApiParameter({
            originalName,
            paramLocation: param.in || '',
            paramSchema: schema,
            description,
            required: param.required || false,
            name: this.getParamName(originalName),
          }),
        );
      }
    }
  }

  private processRequestBody() {
    const requestBody = this.operation.requestBody;
    if (!requestBody || '$ref' in requestBody) {
      return;
    }

    const content = requestBody.content || {};
    // Process first mime type only, similar to python
    const firstMimeType = Object.keys(content)[0];
    if (!firstMimeType) {
      return;
    }

    const mediaTypeObject = content[firstMimeType];
    const schema = mediaTypeObject.schema;
    const description = requestBody.description || '';

    if (schema && !('$ref' in schema)) {
      if (schema.type === 'object') {
        const properties = schema.properties || {};
        if (Object.keys(properties).length > 0) {
          for (const [propName, propDetails] of Object.entries(properties)) {
            this.params.push(
              createApiParameter({
                originalName: propName,
                paramLocation: 'body',
                paramSchema: normalizeSchema(
                  propDetails,
                  `request body property '${propName}'`,
                ),
                required: (schema.required || []).includes(propName),
                name: this.getParamName(propName),
              }),
            );
          }
        } else {
          this.params.push(
            createApiParameter({
              originalName: '',
              paramLocation: 'body',
              paramSchema: schema,
              description,
              required: true,
              name: 'body',
            }),
          );
        }
      } else {
        this.params.push(
          createApiParameter({
            originalName: schema.type === 'array' ? 'array' : 'body',
            paramLocation: 'body',
            paramSchema: schema,
            description,
            required: true,
            name: 'body',
          }),
        );
      }
    }
  }

  private processReturnValue() {
    const responses = this.operation.responses || {};
    // Find first 2xx response
    const validCodes = Object.keys(responses).filter((k) => k.startsWith('2'));
    const min20x = validCodes.sort()[0];

    let returnSchema: OpenAPIV3.SchemaObject = {};

    if (min20x) {
      const response = responses[min20x];
      if (!('$ref' in response) && response.content) {
        const firstMimeType = Object.keys(response.content)[0];
        if (firstMimeType) {
          returnSchema = normalizeSchema(
            response.content[firstMimeType].schema,
            `response '${min20x}' body`,
          );
        }
      }
    }

    this.returnValue = createApiParameter({
      originalName: '',
      paramLocation: '',
      paramSchema: returnSchema,
      required: true,
      name: 'return',
    });
  }

  private dedupeParamNames() {
    const nameCounts = new Map<string, number>();
    for (const param of this.params) {
      const name = param.name;
      const count = nameCounts.get(name) || 0;
      if (count > 0) {
        param.name = `${name}_${count}`;
      }
      nameCounts.set(name, count + 1);
    }
  }

  /**
   * Gets the list of parsed parameters extracted from the OpenAPI operation.
   *
   * @returns An array of parsed parameters.
   */
  @experimental
  public getParameters(): ApiParameter[] {
    return this.params;
  }

  /**
   * Generates a JSON schema representing the arguments of the tool function call.
   *
   * @returns A JSON Schema object.
   */
  @experimental
  public getJsonSchema(): Record<string, unknown> {
    const properties: Record<string, unknown> = {};
    const required: string[] = [];

    for (const param of this.params) {
      properties[param.name] = param.paramSchema;
      if (param.required) {
        required.push(param.name);
      }
    }

    return {
      type: 'object',
      properties,
      required: required.length > 0 ? required : undefined,
      title: `${this.operation.operationId || 'unnamed'}_Arguments`,
    };
  }

  /**
   * Gets a valid tool function name derived from the operation's operationId.
   *
   * @throws {Error} If the operation does not have an operationId.
   * @returns A string representing the function name.
   */
  @experimental
  public getFunctionName(): string {
    const operationId = this.operation.operationId;
    if (!operationId) {
      throw new Error('Operation ID is missing');
    }
    return this.getParamName(operationId).substring(0, 60);
  }

  /**
   * Gets the description of the tool, derived from the operation's description or summary.
   *
   * @returns A string representing the description.
   */
  @experimental
  public getDescription(): string {
    return this.operation.description || this.operation.summary || '';
  }

  /**
   * Gets the TypeScript type name of the value the operation returns.
   *
   * @returns A type name; `unknown` when the operation declares no schema.
   */
  @experimental
  public getReturnTypeHint(): string {
    return getTypeHint(this.returnValue?.paramSchema ?? {});
  }

  /**
   * Gets the name of the security scheme this operation requires.
   *
   * The spec may list several requirements; the first one wins, as it does in
   * adk-python. A requirement that names no scheme yields `''`, which leaves
   * the caller free to fall back to the document-level scheme.
   *
   * @returns The scheme name, or `''` when the operation names none.
   */
  @experimental
  public getAuthSchemeName(): string {
    const security = this.operation.security;
    if (!security || security.length === 0) {
      return '';
    }
    return Object.keys(security[0])[0] ?? '';
  }

  /**
   * Renders the operation as prose: a summary, one line per argument, and the
   * return value.
   *
   * @returns The documentation string.
   */
  @experimental
  public getDocString(): string {
    const summary = this.operation.summary || this.operation.description || '';
    const args = this.params
      .map((param) => `    ${generateParamDoc(param)}`)
      .join('\n');
    const returnDoc = generateReturnDoc(this.operation.responses ?? {});
    return `${summary}\n\nArgs:\n${args}\n\n${returnDoc}`;
  }
}
