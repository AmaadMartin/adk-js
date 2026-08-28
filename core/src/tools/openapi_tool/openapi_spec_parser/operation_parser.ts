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
  requiredSchemeName,
  returnSchema,
  toSnakeCaseName,
} from '../common/common.js';

/**
 * Names a request body that is not an object.
 *
 * A body with no type of its own, including a `oneOf`/`anyOf`/`allOf` body,
 * takes the explicit name. A plain scalar keeps an empty name and picks up
 * `body` from its location, which is the name adk-python gives it.
 */
function bodyArgumentName(schema: OpenAPIV3.SchemaObject): string {
  if (schema.type === 'array') {
    return 'array';
  }
  if (schema.oneOf || schema.anyOf || schema.allOf) {
    return 'body';
  }
  return schema.type ? '' : 'body';
}

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
  private readonly returnValue: ApiParameter;
  private preservePropertyNames: boolean;
  private readonly operation: OpenAPIV3.OperationObject;

  constructor(
    operation: OpenAPIV3.OperationObject | string,
    options: {preservePropertyNames?: boolean} = {},
  ) {
    this.operation = readOperation(operation);
    this.preservePropertyNames = options.preservePropertyNames ?? false;
    this.processOperationParameters();
    this.processRequestBody();
    this.returnValue = this.processReturnValue();
    this.dedupeParamNames();
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
    if (!requestBody) {
      return;
    }
    if ('$ref' in requestBody) {
      throw new Error(
        `Request body contains unresolved reference '${requestBody.$ref}'`,
      );
    }

    const content = requestBody.content || {};
    // Process first mime type only, similar to python
    const mediaType = Object.keys(content)[0];
    if (!mediaType) {
      return;
    }

    const schema = normalizeSchema(
      content[mediaType].schema,
      `request body media type '${mediaType}'`,
    );
    const description = requestBody.description || '';

    if (schema.type === 'object') {
      this.addBodyProperties(schema);
      return;
    }

    this.params.push(
      createApiParameter({
        originalName: bodyArgumentName(schema),
        paramLocation: 'body',
        paramSchema: schema,
        description,
      }),
    );
  }

  /** Expands an object body into one parameter per property. */
  private addBodyProperties(schema: OpenAPIV3.SchemaObject) {
    const required = new Set(schema.required || []);
    for (const [propName, propDetails] of Object.entries(
      schema.properties || {},
    )) {
      const propSchema = normalizeSchema(
        propDetails,
        `request body property '${propName}'`,
      );
      this.params.push(
        createApiParameter({
          originalName: propName,
          paramLocation: 'body',
          paramSchema: propSchema,
          description: propSchema.description || '',
          required: required.has(propName),
          name: this.getParamName(propName),
        }),
      );
    }
  }

  private processReturnValue(): ApiParameter {
    return createApiParameter({
      originalName: '',
      paramLocation: '',
      paramSchema: returnSchema(this.operation.responses || {}),
    });
  }

  private dedupeParamNames() {
    const nameCounts = new Map<string, number>();
    for (const param of this.params) {
      const name = param.name;
      const count = nameCounts.get(name);
      if (count === undefined) {
        nameCounts.set(name, 0);
        continue;
      }
      nameCounts.set(name, count + 1);
      param.name = `${name}_${count}`;
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
    // The tool name is always snake_case: preservePropertyNames governs the
    // argument names the API sees, not the name the model calls.
    return toSnakeCaseName(operationId).substring(0, 60);
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
   * Gets the value the operation returns.
   *
   * @returns The return value.
   */
  @experimental
  public getReturnValue(): ApiParameter {
    return this.returnValue;
  }

  /**
   * Gets the TypeScript type name of the value the operation returns.
   *
   * @throws {Error} If the operation was never parsed.
   * @returns A type name; `unknown` when the operation declares no schema.
   */
  @experimental
  public getReturnTypeHint(): string {
    return getTypeHint(this.getReturnValue().paramSchema);
  }

  /**
   * Gets the name of the security scheme this operation requires.
   *
   * @returns The scheme name, or `''` when the operation requires none.
   */
  @experimental
  public getAuthSchemeName(): string {
    return requiredSchemeName(this.operation.security);
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
