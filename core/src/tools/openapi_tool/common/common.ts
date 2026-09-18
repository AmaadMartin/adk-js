/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {OpenAPIV3} from 'openapi-types';

/**
 * Set of Python reserved keywords (matching Python's `keyword.kwlist`).
 */
const PYTHON_KEYWORDS = new Set([
  'False',
  'None',
  'True',
  'and',
  'as',
  'assert',
  'async',
  'await',
  'break',
  'class',
  'continue',
  'def',
  'del',
  'elif',
  'else',
  'except',
  'finally',
  'for',
  'from',
  'global',
  'if',
  'import',
  'in',
  'is',
  'lambda',
  'nonlocal',
  'not',
  'or',
  'pass',
  'raise',
  'return',
  'try',
  'while',
  'with',
  'yield',
]);

/**
 * Converts a string into snake_case.
 *
 * Handles lowerCamelCase, UpperCamelCase, or space-separated case, acronyms
 * (e.g., "REST API") and consecutive uppercase letters correctly. Also handles
 * mixed cases with and without spaces.
 *
 * Examples:
 * ```
 * toSnakeCase('camelCase') -> 'camel_case'
 * toSnakeCase('UpperCamelCase') -> 'upper_camel_case'
 * toSnakeCase('space separated') -> 'space_separated'
 * ```
 *
 * @param text The input string.
 * @returns The snake_case version of the string.
 */
export function toSnakeCase(text: string): string {
  // Handle spaces and non-alphanumeric characters (replace with underscores)
  let result = text.replace(/[^a-zA-Z0-9]+/g, '_');

  // Insert underscores before uppercase letters (handling both CamelCases)
  result = result.replace(/([a-z0-9])([A-Z])/g, '$1_$2'); // lowerCamelCase
  result = result.replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2'); // UpperCamelCase and acronyms

  // Convert to lowercase
  result = result.toLowerCase();

  // Remove consecutive underscores (clean up extra underscores)
  result = result.replace(/_+/g, '_');

  // Remove leading and trailing underscores
  result = result.replace(/^_+|_+$/g, '');

  return result;
}

export const to_snake_case = toSnakeCase;

/**
 * Renames Python keywords by adding a prefix.
 *
 * Example:
 * ```
 * renamePythonKeywords('if') -> 'param_if'
 * renamePythonKeywords('for') -> 'param_for'
 * ```
 *
 * @param s The input string.
 * @param prefix The prefix to add to the keyword.
 * @returns The renamed string.
 */
export function renamePythonKeywords(s: string, prefix = 'param_'): string {
  if (PYTHON_KEYWORDS.has(s)) {
    return prefix + s;
  }
  return s;
}

export const rename_python_keywords = renamePythonKeywords;

/**
 * Options for constructing an {@link ApiParameter}.
 */
export interface ApiParameterOptions {
  originalName?: string;
  original_name?: string;
  paramLocation?: string;
  param_location?: string;
  paramSchema?: string | OpenAPIV3.SchemaObject | Record<string, unknown>;
  param_schema?: string | OpenAPIV3.SchemaObject | Record<string, unknown>;
  description?: string;
  pyName?: string;
  py_name?: string;
  name?: string;
  required?: boolean;
}

/**
 * Data class representing a function parameter.
 */
export class ApiParameter {
  originalName: string;
  paramLocation: string;
  paramSchema: OpenAPIV3.SchemaObject;
  description: string;
  pyName: string;
  name: string;
  required: boolean;
  typeValue: string;
  typeHint: string;

  constructor(options: ApiParameterOptions) {
    this.originalName = options.originalName ?? options.original_name ?? '';
    this.paramLocation = options.paramLocation ?? options.param_location ?? '';

    const rawSchema = options.paramSchema ?? options.param_schema ?? {};
    if (typeof rawSchema === 'string') {
      this.paramSchema = JSON.parse(rawSchema) as OpenAPIV3.SchemaObject;
    } else {
      this.paramSchema = rawSchema as OpenAPIV3.SchemaObject;
    }

    const customPyName = options.pyName || options.py_name || options.name;
    this.pyName = customPyName
      ? customPyName
      : renamePythonKeywords(toSnakeCase(this.originalName));
    this.name = options.name || this.pyName;
    this.description =
      options.description || this.paramSchema.description || '';
    this.required = options.required ?? false;
    this.typeValue = TypeHintHelper.getTypeValue(this.paramSchema);
    this.typeHint = TypeHintHelper.getTypeHint(this.paramSchema);
  }

  get original_name(): string {
    return this.originalName;
  }

  set original_name(value: string) {
    this.originalName = value;
  }

  get param_location(): string {
    return this.paramLocation;
  }

  set param_location(value: string) {
    this.paramLocation = value;
  }

  get param_schema(): OpenAPIV3.SchemaObject {
    return this.paramSchema;
  }

  set param_schema(value: OpenAPIV3.SchemaObject) {
    this.paramSchema = value;
  }

  get py_name(): string {
    return this.pyName;
  }

  set py_name(value: string) {
    this.pyName = value;
    this.name = value;
  }

  get type_value(): string {
    return this.typeValue;
  }

  set type_value(value: string) {
    this.typeValue = value;
  }

  get type_hint(): string {
    return this.typeHint;
  }

  set type_hint(value: string) {
    this.typeHint = value;
  }

  toString(): string {
    return `${this.pyName}: ${this.typeHint}`;
  }

  /**
   * Converts the parameter to an argument string for function call.
   */
  toArgString(): string {
    return `${this.pyName}=${this.pyName}`;
  }

  to_arg_string(): string {
    return this.toArgString();
  }

  /**
   * Converts the parameter to a key:value string for dict property.
   */
  toDictProperty(): string {
    return `"${this.pyName}": ${this.pyName}`;
  }

  to_dict_property(): string {
    return this.toDictProperty();
  }

  /**
   * Converts the parameter to a PyDoc parameter docstr.
   */
  toPydocString(): string {
    return PydocHelper.generateParamDoc(this);
  }

  to_pydoc_string(): string {
    return this.toPydocString();
  }

  /**
   * Serializes the parameter to a plain object matching `model_dump()`.
   */
  modelDump(): Record<string, unknown> {
    return {
      original_name: this.originalName,
      param_location: this.paramLocation,
      param_schema: JSON.parse(JSON.stringify(this.paramSchema)),
      description: this.description,
      py_name: this.pyName,
    };
  }

  model_dump(): Record<string, unknown> {
    return this.modelDump();
  }

  toJSON(): Record<string, unknown> {
    return this.modelDump();
  }
}

/**
 * Helper class for generating type hints.
 */
export class TypeHintHelper {
  /**
   * Generates the Python type value representation for a given parameter.
   */
  static getTypeValue(
    schema?: OpenAPIV3.SchemaObject | Record<string, unknown>,
  ): string {
    const paramType =
      schema && typeof schema.type === 'string' ? schema.type : 'Any';

    if (paramType === 'integer') {
      return 'int';
    } else if (paramType === 'number') {
      return 'float';
    } else if (paramType === 'boolean') {
      return 'bool';
    } else if (paramType === 'string') {
      return 'str';
    } else if (paramType === 'array') {
      let itemsType = 'Any';
      const items = (schema as OpenAPIV3.ArraySchemaObject | undefined)
        ?.items as OpenAPIV3.SchemaObject | undefined;
      if (items && typeof items.type === 'string') {
        itemsType = items.type;
      }

      if (itemsType === 'object') {
        return 'List[Dict[str, Any]]';
      } else {
        const typeMap: Record<string, string> = {
          integer: 'int',
          number: 'float',
          boolean: 'bool',
          string: 'str',
          object: 'Dict[str, Any]',
          array: 'List[Any]',
        };
        return `List[${typeMap[itemsType] ?? 'Any'}]`;
      }
    } else if (paramType === 'object') {
      return 'Dict[str, Any]';
    } else {
      return 'Any';
    }
  }

  static get_type_value(
    schema?: OpenAPIV3.SchemaObject | Record<string, unknown>,
  ): string {
    return TypeHintHelper.getTypeValue(schema);
  }

  /**
   * Generates the Python type in string for a given parameter.
   */
  static getTypeHint(
    schema?: OpenAPIV3.SchemaObject | Record<string, unknown>,
  ): string {
    const paramType =
      schema && typeof schema.type === 'string' ? schema.type : 'Any';

    if (paramType === 'integer') {
      return 'int';
    } else if (paramType === 'number') {
      return 'float';
    } else if (paramType === 'boolean') {
      return 'bool';
    } else if (paramType === 'string') {
      return 'str';
    } else if (paramType === 'array') {
      let itemsType = 'Any';
      const items = (schema as OpenAPIV3.ArraySchemaObject | undefined)
        ?.items as OpenAPIV3.SchemaObject | undefined;
      if (items && typeof items.type === 'string') {
        itemsType = items.type;
      }

      if (itemsType === 'object') {
        return 'List[Dict[str, Any]]';
      } else {
        const typeMap: Record<string, string> = {
          integer: 'int',
          number: 'float',
          boolean: 'bool',
          string: 'str',
        };
        return `List[${typeMap[itemsType] ?? 'Any'}]`;
      }
    } else if (paramType === 'object') {
      return 'Dict[str, Any]';
    } else {
      return 'Any';
    }
  }

  static get_type_hint(
    schema?: OpenAPIV3.SchemaObject | Record<string, unknown>,
  ): string {
    return TypeHintHelper.getTypeHint(schema);
  }
}

/**
 * Interface representing a response entry in an OpenAPI Operation.
 */
export interface OpenApiResponseLike {
  description?: string;
  content?: Record<
    string,
    {
      schema?: OpenAPIV3.SchemaObject;
      schema_?: OpenAPIV3.SchemaObject;
    }
  >;
}

/**
 * Helper class for generating PyDoc strings.
 */
export class PydocHelper {
  /**
   * Generates a parameter documentation string.
   *
   * @param param The parameter to generate the documentation for.
   * @returns The generated parameter Python documentation string.
   */
  static generateParamDoc(param: ApiParameter): string {
    const description = param.description ? param.description.trim() : '';
    let paramDoc = `${param.pyName} (${param.typeHint}): ${description}`;

    if (param.paramSchema.type === 'object') {
      const properties = param.paramSchema.properties as
        | Record<string, OpenAPIV3.SchemaObject>
        | undefined;
      if (properties && Object.keys(properties).length > 0) {
        paramDoc += ' Object properties:\n';
        for (const [propName, propDetails] of Object.entries(properties)) {
          const propDesc = propDetails.description || '';
          const propType = TypeHintHelper.getTypeHint(propDetails);
          paramDoc += `       ${propName} (${propType}): ${propDesc}\n`;
        }
      }
    }

    return paramDoc;
  }

  static generate_param_doc(param: ApiParameter): string {
    return PydocHelper.generateParamDoc(param);
  }

  /**
   * Generates a return value documentation string.
   *
   * @param responses Response map in an OpenAPI Operation.
   * @returns The generated return value Python documentation string.
   */
  static generateReturnDoc(
    responses: Record<string, OpenApiResponseLike | OpenAPIV3.ResponseObject>,
  ): string {
    let returnDoc = '';

    // Only consider 2xx responses for return type hinting.
    // Returns the 2xx response with the smallest status code number and with
    // content defined.
    const sortedResponses = Object.entries(responses).sort((a, b) => {
      const codeA = Number.parseInt(a[0], 10);
      const codeB = Number.parseInt(b[0], 10);
      const valA = Number.isNaN(codeA) ? Number.POSITIVE_INFINITY : codeA;
      const valB = Number.isNaN(codeB) ? Number.POSITIVE_INFINITY : codeB;
      return valA - valB;
    });

    const qualifiedResponse = sortedResponses.find(
      ([code, resp]) =>
        code.startsWith('2') &&
        resp &&
        'content' in resp &&
        resp.content &&
        Object.keys(resp.content).length > 0,
    );

    if (!qualifiedResponse) {
      return '';
    }

    const responseDetails = qualifiedResponse[1] as OpenApiResponseLike;
    const description = (responseDetails.description || '').trim();
    const content = responseDetails.content || {};

    // Generate return type hint and properties for the first response type.
    for (const [, schemaDetails] of Object.entries(content)) {
      const schema =
        schemaDetails.schema ??
        schemaDetails.schema_ ??
        ({} as OpenAPIV3.SchemaObject);

      const dummyParam = new ApiParameter({
        originalName: '',
        paramLocation: '',
        paramSchema: schema,
      });
      returnDoc = `Returns (${dummyParam.typeHint}): ${description}`;

      const responseType = schema.type || 'Any';
      if (responseType !== 'object') {
        break;
      }
      const properties = schema.properties as
        | Record<string, OpenAPIV3.SchemaObject>
        | undefined;
      if (!properties || Object.keys(properties).length === 0) {
        break;
      }
      returnDoc += ' Object properties:\n';
      for (const [propName, propDetails] of Object.entries(properties)) {
        const propDesc = propDetails.description || '';
        const propType = TypeHintHelper.getTypeHint(propDetails);
        returnDoc += `        ${propName} (${propType}): ${propDesc}\n`;
      }
      break;
    }

    return returnDoc;
  }

  static generate_return_doc(
    responses: Record<string, OpenApiResponseLike | OpenAPIV3.ResponseObject>,
  ): string {
    return PydocHelper.generateReturnDoc(responses);
  }
}
