/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {OpenAPIV3} from 'openapi-types';
import {toSnakeCaseIdentifier} from '../../../utils/case_utils.js';
import {experimental} from '../../../utils/experimental.js';
import {
  createApiParameter,
  findResponseMediaType,
  findSuccessResponse,
  type ApiParameter,
} from '../common/common.js';

/**
 * Narrows a schema the document may leave unusable.
 *
 * `resolveReferences` leaves a dangling internal `$ref` in place, and one
 * broken pointer must not cost every tool in the document, so an unreadable
 * schema becomes an unconstrained one.
 */
function toSchemaObject(
  value: OpenAPIV3.SchemaObject | OpenAPIV3.ReferenceObject | undefined,
): OpenAPIV3.SchemaObject {
  return value && !('$ref' in value) ? value : {};
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

  constructor(
    private readonly operation: OpenAPIV3.OperationObject,
    options: {preservePropertyNames?: boolean} = {},
  ) {
    this.preservePropertyNames = options.preservePropertyNames ?? false;
    this.processOperationParameters();
    this.processRequestBody();
    this.processReturnValue();
    this.dedupeParamNames();
  }

  /** The name to force on a parameter, or nothing to let it derive one. */
  private overrideName(originalName: string): string | undefined {
    return this.preservePropertyNames ? originalName : undefined;
  }

  private processOperationParameters() {
    const parameters = this.operation.parameters || [];
    for (const param of parameters) {
      // Assume resolved references for now
      if ('name' in param) {
        this.params.push(
          createApiParameter({
            originalName: param.name,
            paramLocation: param.in || '',
            paramSchema: toSchemaObject(param.schema),
            description: param.description || '',
            required: param.required || false,
            name: this.overrideName(param.name),
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
            if (!('$ref' in propDetails)) {
              this.params.push(
                createApiParameter({
                  originalName: propName,
                  paramLocation: 'body',
                  paramSchema: propDetails,
                  description: propDetails.description,
                  required: (schema.required || []).includes(propName),
                  name: this.overrideName(propName),
                }),
              );
            }
          }
        } else {
          this.params.push({
            originalName: '',
            paramLocation: 'body',
            paramSchema: schema,
            description,
            required: true,
            name: 'body',
          });
        }
      } else if (schema.type === 'array') {
        this.params.push({
          originalName: 'array',
          paramLocation: 'body',
          paramSchema: schema,
          description,
          required: true,
          name: 'body',
        });
      } else {
        this.params.push({
          originalName: 'body',
          paramLocation: 'body',
          paramSchema: schema,
          description,
          required: true,
          name: 'body',
        });
      }
    }
  }

  private processReturnValue() {
    const response = findSuccessResponse(this.operation.responses || {});
    const mediaType = response && findResponseMediaType(response);
    const returnSchema = toSchemaObject(mediaType?.schema);

    this.returnValue = {
      originalName: '',
      paramLocation: '',
      paramSchema: returnSchema,
      required: true,
      name: 'return',
    };
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
    const name = this.preservePropertyNames
      ? operationId
      : toSnakeCaseIdentifier(operationId);
    return name.substring(0, 60);
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
}
