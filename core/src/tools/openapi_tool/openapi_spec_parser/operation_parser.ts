/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {OpenAPIV3} from 'openapi-types';
import {experimental} from '../../../utils/experimental.js';
import {
  ApiParameter as CommonApiParameter,
  PydocHelper,
  toSnakeCase,
  TypeHintHelper,
} from '../common/common.js';

export interface ApiParameter {
  originalName: string;
  paramLocation: string;
  paramSchema: OpenAPIV3.SchemaObject;
  description?: string;
  name: string; // The name used in the generated tool schema (may be snake_cased)
  required: boolean;
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
    operation: OpenAPIV3.OperationObject | Record<string, unknown> | string,
    options: {preservePropertyNames?: boolean; shouldParse?: boolean} = {},
  ) {
    if (typeof operation === 'string') {
      this.operation = JSON.parse(operation) as OpenAPIV3.OperationObject;
    } else {
      this.operation = operation as OpenAPIV3.OperationObject;
    }
    this.preservePropertyNames = options.preservePropertyNames ?? false;
    if (options.shouldParse !== false) {
      this.processOperationParameters();
      this.processRequestBody();
      this.processReturnValue();
      this.dedupeParamNames();
    }
  }

  /**
   * Loads a pre-parsed OperationParser from an operation, parameters list, and optional return value.
   */
  @experimental
  public static load(
    operation: OpenAPIV3.OperationObject | Record<string, unknown> | string,
    params: ApiParameter[],
    returnValue?: ApiParameter,
  ): OperationParser {
    const parser = new OperationParser(operation, {shouldParse: false});
    parser.params = params;
    parser.returnValue = returnValue;
    return parser;
  }

  private getParamName(originalName: string): string {
    if (this.preservePropertyNames || /^[a-z0-9_]+$/.test(originalName)) {
      return originalName;
    }
    return toSnakeCase(originalName);
  }

  private processOperationParameters() {
    const parameters = this.operation.parameters || [];
    for (const param of parameters) {
      // Assume resolved references for now
      if ('name' in param) {
        const originalName = param.name;
        const description = param.description || '';
        const location = param.in || '';
        const schema = (param.schema as OpenAPIV3.SchemaObject) || {};

        this.params.push({
          originalName,
          paramLocation: location,
          paramSchema: schema,
          description,
          required: param.required || false,
          name: this.getParamName(originalName),
        });
      }
    }
  }

  private processRequestBody() {
    const requestBody = this.operation.requestBody;
    if (!requestBody || '$ref' in requestBody) {
      return;
    }

    const content = requestBody.content || {};
    // Process the first mime type only.
    const firstMimeType = Object.keys(content)[0];
    if (!firstMimeType) {
      return;
    }

    const mediaTypeObject = content[firstMimeType];
    // A media type may omit `schema`, which describes an unconstrained payload
    // rather than the absence of one. adk-python reads it as an empty schema
    // and still advertises a `body` argument for it.
    const schema: OpenAPIV3.SchemaObject | OpenAPIV3.ReferenceObject =
      mediaTypeObject.schema ?? {};
    const description = requestBody.description || '';

    if (!('$ref' in schema)) {
      if (schema.type === 'object') {
        const properties = schema.properties || {};
        if (Object.keys(properties).length > 0) {
          for (const [propName, propDetails] of Object.entries(properties)) {
            if (!('$ref' in propDetails)) {
              this.params.push({
                originalName: propName,
                paramLocation: 'body',
                paramSchema: propDetails,
                description: propDetails.description,
                required: (schema.required || []).includes(propName),
                name: this.getParamName(propName),
              });
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
          const schema = response.content[firstMimeType].schema;
          if (schema && !('$ref' in schema)) {
            returnSchema = schema;
          }
        }
      }
    }

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

  public get_parameters(): ApiParameter[] {
    return this.getParameters();
  }

  /**
   * Gets the parsed return value parameter for the operation.
   */
  @experimental
  public getReturnValue(): ApiParameter | undefined {
    return this.returnValue;
  }

  public get_return_value(): ApiParameter | undefined {
    return this.getReturnValue();
  }

  /**
   * Returns the return type hint string (e.g. 'str', 'int', 'Dict[str, Any]', 'Any').
   */
  @experimental
  public getReturnTypeHint(): string {
    return TypeHintHelper.getTypeHint(this.returnValue?.paramSchema);
  }

  public get_return_type_hint(): string {
    return this.getReturnTypeHint();
  }

  /**
   * Returns the return type value string.
   */
  @experimental
  public getReturnTypeValue(): string {
    return TypeHintHelper.getTypeValue(this.returnValue?.paramSchema);
  }

  public get_return_type_value(): string {
    return this.getReturnTypeValue();
  }

  /**
   * Returns the name of the first security scheme configured on this operation, or empty string.
   */
  @experimental
  public getAuthSchemeName(): string {
    if (this.operation.security && this.operation.security.length > 0) {
      return Object.keys(this.operation.security[0])[0] || '';
    }
    return '';
  }

  public get_auth_scheme_name(): string {
    return this.getAuthSchemeName();
  }

  /**
   * Generates a PyDoc string describing the operation, its arguments, and return value.
   */
  @experimental
  public getPydocString(): string {
    const docDesc = this.getDescription();
    const argDocs = this.params.map((p) =>
      PydocHelper.generateParamDoc(
        new CommonApiParameter({
          originalName: p.originalName,
          paramLocation: p.paramLocation,
          paramSchema: p.paramSchema,
          description: p.description,
          pyName: p.name,
          required: p.required,
        }),
      ),
    );
    const returnDoc = PydocHelper.generateReturnDoc(
      (this.operation.responses || {}) as Record<
        string,
        OpenAPIV3.ResponseObject
      >,
    );
    let fullDoc = docDesc;
    if (argDocs.length > 0) {
      fullDoc += `\n\nArgs:\n  ${argDocs.join('\n  ')}`;
    }
    if (returnDoc) {
      fullDoc += `\n\n${returnDoc}`;
    }
    return fullDoc.trim();
  }

  public get_pydoc_string(): string {
    return this.getPydocString();
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
      required,
      title: `${this.operation.operationId || 'unnamed'}_Arguments`,
    };
  }

  public get_json_schema(): Record<string, unknown> {
    return this.getJsonSchema();
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

  public get_function_name(): string {
    return this.getFunctionName();
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

  public get_description(): string {
    return this.getDescription();
  }
}
