/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Type} from '@google/genai';
import {OpenAPIV3} from 'openapi-types';
import {toSnakeCaseName} from '../../../utils/case_utils.js';
import {experimental} from '../../../utils/experimental.js';
import {toGeminiType} from '../../../utils/gemini_schema_util.js';
import type {ApiParameter} from '../common/common.js';
import {generateParamDoc, generateReturnDoc, typeHint} from './doc_strings.js';
import {deriveParameterName} from './parameter_names.js';

// `ApiParameter` now lives in the OpenAPI common module. It is re-exported here
// so the modules that already import it from this file keep working.
export type {ApiParameter};

/**
 * The JSON Schema describing a tool function's arguments.
 *
 * Always an object schema, so it can be converted to a Gemini `Schema` without
 * a cast.
 */
export interface ToolArgumentsSchema {
  type: 'object';
  properties: Record<string, unknown>;
  required?: string[];
  title: string;
}

/** Options accepted by `OperationParser`. */
export interface OperationParserOptions {
  preservePropertyNames?: boolean;
  /**
   * Parameters that are already parsed. When a caller sets them the operation
   * is not read, so a name the caller renamed or de-duplicated survives.
   */
  parameters?: ApiParameter[];
  /** The return value that goes with `parameters`. */
  returnValue?: ApiParameter;
}

/** The length a generated tool function name is cut down to. */
const MAX_FUNCTION_NAME_LENGTH = 60;

/**
 * Returns the name of the security scheme a requirement list makes mandatory,
 * or an empty string when the list makes none.
 *
 * OpenAPI 3.0.3 treats an empty requirement object (`{}`) as an alternative
 * that needs no credential, so a list holding one allows anonymous access.
 * Only the first of the remaining alternatives is honoured, because a tool
 * carries one credential.
 */
export function requiredSchemeName(
  security: OpenAPIV3.SecurityRequirementObject[] | undefined,
): string {
  if (!security?.length) {
    return '';
  }
  if (security.some((requirement) => Object.keys(requirement).length === 0)) {
    return '';
  }
  return Object.keys(security[0])[0];
}

/**
 * Reads an operation supplied as a JSON string.
 *
 * @throws {Error} If the JSON holds anything other than an object.
 */
function parseOperationJson(operation: string): OpenAPIV3.OperationObject {
  const parsed: unknown = JSON.parse(operation);
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('Operation must be a JSON object');
  }
  return parsed as OpenAPIV3.OperationObject;
}

/**
 * Returns the `originalName` a request body parameter carries. It decides both
 * the argument name and how `RestApiTool` places the value in the request.
 *
 * An array body is named `array`, and a body whose type the schema does not
 * state is named `body`. A scalar body gets an empty name, so its parameter
 * location names it instead.
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

/** Builds the return value that carries a response schema. */
function returnValueOf(paramSchema: OpenAPIV3.SchemaObject): ApiParameter {
  return {
    originalName: '',
    paramLocation: '',
    paramSchema,
    required: true,
    name: 'return',
  };
}

/**
 * Parses an OpenAPI OperationObject and extracts its parameters, request body, and return value.
 *
 * It maps OpenAPI parameters and request bodies into a flat list of `ApiParameter` objects
 * that are compatible with Gemini's tool function declarations.
 */
@experimental
export class OperationParser {
  private readonly operation: OpenAPIV3.OperationObject;
  private params: ApiParameter[] = [];
  private readonly returnValue: ApiParameter = returnValueOf({});
  private preservePropertyNames: boolean;

  constructor(
    operation: OpenAPIV3.OperationObject | string,
    options: OperationParserOptions = {},
  ) {
    this.operation =
      typeof operation === 'string' ? parseOperationJson(operation) : operation;
    this.preservePropertyNames = options.preservePropertyNames ?? false;
    if (options.parameters) {
      this.params = options.parameters;
      this.returnValue = options.returnValue ?? this.returnValue;
      return;
    }
    this.processOperationParameters();
    this.processRequestBody();
    this.returnValue = this.parseReturnValue();
    this.dedupeParamNames();
  }

  private getParamName(originalName: string, paramLocation: string): string {
    return deriveParameterName(
      originalName,
      paramLocation,
      this.preservePropertyNames,
    );
  }

  private processOperationParameters() {
    const parameters = this.operation.parameters || [];
    for (const param of parameters) {
      // Assume resolved references for now
      if ('name' in param) {
        const originalName = param.name;
        const location = param.in || '';
        const declared = (param.schema as OpenAPIV3.SchemaObject) || {};
        // The model reads the schema, not the parameter around it. Copy rather
        // than patch, so the caller's operation object stays unchanged.
        const schema =
          !declared.description && param.description
            ? {...declared, description: param.description}
            : declared;

        this.params.push({
          originalName,
          paramLocation: location,
          paramSchema: schema,
          description: param.description || schema.description || '',
          required: param.required || false,
          name: this.getParamName(originalName, location),
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
    // Process first mime type only, similar to python
    const firstMimeType = Object.keys(content)[0];
    if (!firstMimeType) {
      return;
    }

    const schema = content[firstMimeType].schema;
    if (!schema || '$ref' in schema) {
      return;
    }

    if (schema.type === 'object') {
      for (const [propName, propDetails] of Object.entries(
        schema.properties || {},
      )) {
        if (!('$ref' in propDetails)) {
          this.params.push({
            originalName: propName,
            paramLocation: 'body',
            paramSchema: propDetails,
            description: propDetails.description ?? '',
            required: (schema.required || []).includes(propName),
            name: this.getParamName(propName, 'body'),
          });
        }
      }
      return;
    }

    const originalName = bodyArgumentName(schema);
    this.params.push({
      originalName,
      paramLocation: 'body',
      paramSchema: schema,
      description: requestBody.description || schema.description || '',
      required: false,
      name: this.getParamName(originalName, 'body'),
    });
  }

  private parseReturnValue(): ApiParameter {
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

    return returnValueOf(returnSchema);
  }

  private dedupeParamNames() {
    const nameCounts = new Map<string, number>();
    for (const param of this.params) {
      const name = param.name;
      const seen = nameCounts.get(name);
      if (seen === undefined) {
        nameCounts.set(name, 0);
        continue;
      }
      nameCounts.set(name, seen + 1);
      param.name = `${name}_${seen}`;
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
   * Gets the operation's return value, taken from its lowest 2xx response.
   *
   * The schema is empty when the operation declares no 2xx response, or when
   * that response carries no usable schema.
   *
   * @returns The parsed return value.
   */
  @experimental
  public getReturnValue(): ApiParameter {
    return this.returnValue;
  }

  /**
   * Gets the TypeScript type name that describes what the operation returns.
   *
   * @returns A type name such as `string`, or `unknown` when the response
   *   declares no type.
   */
  @experimental
  public getReturnTypeHint(): string {
    return typeHint(this.returnValue.paramSchema);
  }

  /**
   * Gets the Gemini type of what the operation returns.
   *
   * @returns The matching `Type`, or `Type.TYPE_UNSPECIFIED` when the response
   *   declares no type.
   */
  @experimental
  public getReturnTypeValue(): Type {
    return toGeminiType(this.returnValue.paramSchema.type);
  }

  /**
   * Gets the name of the security scheme this operation requires.
   *
   * @returns The scheme name, or an empty string when the operation needs no
   *   credential.
   */
  @experimental
  public getAuthSchemeName(): string {
    return requiredSchemeName(this.operation.security);
  }

  /**
   * Generates a JSON schema representing the arguments of the tool function call.
   *
   * @returns A JSON Schema object.
   */
  @experimental
  public getJsonSchema(): ToolArgumentsSchema {
    const properties: Record<string, unknown> = {};
    const required: string[] = [];

    for (const param of this.params) {
      properties[param.name] = JSON.parse(JSON.stringify(param.paramSchema));
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
    return toSnakeCaseName(operationId).substring(0, MAX_FUNCTION_NAME_LENGTH);
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
   * Gets the documentation the model reads: the summary, one line for each
   * argument, and what the operation returns.
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
