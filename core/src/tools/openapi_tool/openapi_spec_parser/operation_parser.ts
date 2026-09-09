/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {OpenAPIV3} from 'openapi-types';
import {toSnakeCaseName} from '../../../utils/case_utils.js';
import {experimental} from '../../../utils/experimental.js';
import {deriveParameterName} from './parameter_names.js';

export interface ApiParameter {
  originalName: string;
  paramLocation: string;
  paramSchema: OpenAPIV3.SchemaObject;
  description?: string;
  name: string; // The name used in the generated tool schema (may be snake_cased)
  required: boolean;
}

/** Options that change how an operation's arguments are named. */
export interface OperationParserOptions {
  /**
   * Keeps each argument under the name the OpenAPI document gives it, instead
   * of converting it to snake_case.
   */
  preservePropertyNames?: boolean;
}

/** The length a generated tool function name is cut down to. */
const MAX_FUNCTION_NAME_LENGTH = 60;

/**
 * Returns the name of the security scheme an operation requires.
 *
 * Only the first alternative is honoured, because a tool carries one
 * credential. adk-python reads the same first entry, but raises IndexError
 * when that entry is an empty requirement; an empty requirement is legal
 * OpenAPI meaning anonymous access, so this returns an empty string instead.
 */
export function requiredSchemeName(
  security: OpenAPIV3.SecurityRequirementObject[] | undefined,
): string {
  const first = security?.[0];
  return first ? (Object.keys(first)[0] ?? '') : '';
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

/**
 * Reports whether a decoded JSON value can be read as an operation.
 *
 * The check stops at object-ness. adk-python validates the operation's shape
 * through pydantic, which has no TypeScript counterpart: every member this
 * parser reads is optional at runtime, and `OpenAPIV3.OperationObject` already
 * describes the object form structurally.
 */
function isOperationObject(value: unknown): value is OpenAPIV3.OperationObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Reads an operation supplied as JSON text.
 *
 * @param json The operation as JSON text.
 * @throws {Error} If the text is not JSON, or is JSON that does not describe
 *   an object.
 * @returns The parsed operation.
 */
function parseOperationJson(json: string): OpenAPIV3.OperationObject {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (error: unknown) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`Operation is not valid JSON: ${reason}`);
  }
  if (!isOperationObject(parsed)) {
    throw new Error('Operation must be a JSON object');
  }
  return parsed;
}

/** The TypeScript type name each OpenAPI scalar type maps onto. */
const SCALAR_TYPE_HINTS = new Map([
  ['string', 'string'],
  ['integer', 'number'],
  ['number', 'number'],
  ['boolean', 'boolean'],
  ['object', 'Record<string, unknown>'],
]);

/** The type name used for a schema this mapping does not cover. */
const UNKNOWN_TYPE_HINT = 'unknown';

/** Indent of an argument line in the `Args:` section. */
const ARG_INDENT = ' '.repeat(8);

/** Indent of an object property line inside an argument's documentation. */
const PARAM_PROPERTY_INDENT = ' '.repeat(7);

/** Indent of an object property line inside the return documentation. */
const RETURN_PROPERTY_INDENT = ' '.repeat(8);

/**
 * Returns the single type name a schema declares.
 *
 * OpenAPI 3.1 allows a list of types. A list that names one type besides
 * `null` describes that type; any other list is ambiguous and names nothing.
 */
function schemaTypeName(schema: OpenAPIV3.SchemaObject): string {
  const declared: unknown = schema.type;
  if (Array.isArray(declared)) {
    const named = declared.filter((entry) => entry !== 'null');
    return named.length === 1 && typeof named[0] === 'string' ? named[0] : '';
  }
  return typeof declared === 'string' ? declared : '';
}

/**
 * Replaces a `$ref` with an empty schema. The operation reaches this parser
 * already resolved, so an unresolved reference carries no type to describe.
 */
function schemaOrEmpty(
  schema: OpenAPIV3.ReferenceObject | OpenAPIV3.SchemaObject | undefined,
): OpenAPIV3.SchemaObject {
  return !schema || '$ref' in schema ? {} : schema;
}

/**
 * Returns the TypeScript type name that describes an OpenAPI schema.
 *
 * @param schema The schema to describe.
 * @returns A TypeScript type name, or `unknown` when the schema declares no
 *   type this mapping covers.
 */
function typeHint(schema: OpenAPIV3.SchemaObject): string {
  const typeName = schemaTypeName(schema);
  if (typeName === 'array') {
    const items = 'items' in schema ? schemaOrEmpty(schema.items) : {};
    const itemHint =
      SCALAR_TYPE_HINTS.get(schemaTypeName(items)) ?? UNKNOWN_TYPE_HINT;
    return `${itemHint}[]`;
  }
  return SCALAR_TYPE_HINTS.get(typeName) ?? UNKNOWN_TYPE_HINT;
}

/**
 * Documents the properties of an object schema, one indented line each.
 * Returns an empty string for any other schema.
 */
function objectPropertiesDoc(
  schema: OpenAPIV3.SchemaObject,
  indent: string,
): string {
  const properties =
    schemaTypeName(schema) === 'object' ? (schema.properties ?? {}) : {};
  const names = Object.keys(properties);
  if (names.length === 0) {
    return '';
  }
  let doc = ' Object properties:\n';
  for (const name of names) {
    const property = schemaOrEmpty(properties[name]);
    doc += `${indent}${name} (${typeHint(property)}): ${property.description ?? ''}\n`;
  }
  return doc;
}

/**
 * Documents one tool argument, so the model learns its name, type and purpose.
 *
 * @param param The parsed parameter to document.
 * @returns The documentation line, plus a property block for an object schema.
 */
function parameterDoc(param: ApiParameter): string {
  const description = (param.description ?? '').trim();
  const doc = `${param.name} (${typeHint(param.paramSchema)}): ${description}`;
  return doc + objectPropertiesDoc(param.paramSchema, PARAM_PROPERTY_INDENT);
}

/**
 * The order a response status sorts in. Numeric statuses sort ascending and
 * before the non-numeric ones OpenAPI also allows, such as `default` and
 * `2XX`.
 */
function statusOrder(status: string): number {
  return /^\d+$/.test(status) ? Number(status) : Number.POSITIVE_INFINITY;
}

/**
 * Documents what an operation returns, taking the 2xx response with the
 * smallest status code that carries content.
 *
 * This selection is stricter than the one `processReturnValue` makes: the
 * documentation needs a response that describes something, while the return
 * value tracks the lowest 2xx response whether or not it has content.
 *
 * @param responses The responses the operation declares.
 * @returns The return documentation, or an empty string when no 2xx response
 *   carries a schema.
 */
function returnDoc(responses: OpenAPIV3.ResponsesObject): string {
  const sorted = Object.entries(responses).sort(
    ([left], [right]) => statusOrder(left) - statusOrder(right),
  );

  for (const [status, response] of sorted) {
    if (!status.startsWith('2') || '$ref' in response) {
      continue;
    }
    const content = response.content ?? {};
    const mediaType = content['application/json'] ?? Object.values(content)[0];
    if (!mediaType) {
      continue;
    }
    if (!mediaType.schema) {
      return '';
    }
    const schema = schemaOrEmpty(mediaType.schema);
    const description = response.description.trim();
    return (
      `Returns (${typeHint(schema)}): ${description}` +
      objectPropertiesDoc(schema, RETURN_PROPERTY_INDENT)
    );
  }
  return '';
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
  private params: ApiParameter[] = [];
  private returnValue: ApiParameter = returnValueOf({});
  private preservePropertyNames: boolean;
  private readonly operation: OpenAPIV3.OperationObject;

  constructor(
    operation: OpenAPIV3.OperationObject | string,
    options: OperationParserOptions = {},
  ) {
    this.operation =
      typeof operation === 'string' ? parseOperationJson(operation) : operation;
    this.preservePropertyNames = options.preservePropertyNames ?? false;
    this.processOperationParameters();
    this.processRequestBody();
    this.processReturnValue();
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
        const description = param.description || '';
        const location = param.in || '';
        const schema = (param.schema as OpenAPIV3.SchemaObject) || {};

        this.params.push({
          originalName,
          paramLocation: location,
          paramSchema: schema,
          description,
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
      // adk-python builds this parameter without a `required` argument, so it
      // takes ApiParameter's default of false even when the body is mandatory.
      // Honouring requestBody.required here would give the two SDKs different
      // required sets for one document.
      required: false,
      name: this.getParamName(originalName, 'body'),
    });
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

    this.returnValue = returnValueOf(returnSchema);
  }

  private dedupeParamNames() {
    const nameCounts = new Map<string, number>();
    for (const param of this.params) {
      const name = param.name;
      const seen = (nameCounts.get(name) ?? -1) + 1;
      nameCounts.set(name, seen);
      if (seen > 0) {
        param.name = `${name}_${seen - 1}`;
      }
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
   * Gets the value the operation returns.
   *
   * @returns The return value, carrying the schema of the 2xx response with
   *   the smallest status code.
   */
  @experimental
  public getReturnValue(): ApiParameter {
    return this.returnValue;
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
   * Documents the operation: a heading, every argument, and what it returns.
   *
   * This is adk-python's `get_pydoc_string` without the triple quotes, which
   * only exist because Python generates source text from it. The heading
   * prefers the summary, while `getDescription()` prefers the description;
   * adk-python orders the two the same opposite way.
   *
   * @returns The documentation text. The `Returns` section is absent when no
   *   2xx response carries a schema.
   */
  @experimental
  public getDocString(): string {
    const heading = this.operation.summary || this.operation.description || '';
    const args = this.params
      .map((param) => `${ARG_INDENT}${parameterDoc(param)}`)
      .join('\n');
    const returns = returnDoc(this.operation.responses || {});

    const sections = [heading, args ? `Args:\n${args}` : 'Args:'];
    if (returns) {
      sections.push(returns);
    }
    return sections.join('\n\n').trim();
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
      properties[param.name] = structuredClone(param.paramSchema);
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
}
