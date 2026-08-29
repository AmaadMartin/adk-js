/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {FunctionDeclaration, Schema, Type} from '@google/genai';
import {z as z3} from 'zod/v3';
import {z as z4} from 'zod/v4';

import {isZodObject, zodObjectToSchema} from '../utils/simple_zod_to_json.js';
import {GoogleLLMVariant} from '../utils/variant_utils.js';

/**
 * A JSON Schema node as handed over by a tool wrapper that already owns a
 * schema for its arguments.
 *
 * It differs from the genai {@link Schema} in one way: `type` is still a raw
 * schema or language type name (`'str'`, `'string'`, `'Dict'`, `'STRING'`)
 * rather than a {@link Type} member. Every genai `Schema` therefore satisfies
 * this type, but not the other way round.
 */
export type JsonSchemaNode = Omit<
  Schema,
  'type' | 'items' | 'anyOf' | 'properties'
> & {
  type?: string;
  items?: JsonSchemaNode;
  anyOf?: JsonSchemaNode[];
  properties?: Record<string, JsonSchemaNode>;
};

/**
 * The parameter sources a declaration can be built from, mirroring
 * `ToolInputParameters`.
 */
export type FunctionDeclarationParameters =
  | z3.ZodObject<z3.ZodRawShape>
  | z4.ZodObject<z4.ZodRawShape>
  | Schema
  | JsonSchemaNode
  | undefined;

/** Options for {@link buildFunctionDeclaration}. */
export interface BuildFunctionDeclarationOptions {
  /** Declared tool name. Required and non-empty. */
  name: string;
  description?: string;
  parameters?: FunctionDeclarationParameters;
  /** Parameter names to drop, e.g. `['toolContext']`. */
  ignoreParams?: string[];
  variant?: GoogleLLMVariant;
  /**
   * Name of the tool's return type, e.g. `'str'` or `'None'`. Replaces the
   * return annotation adk-python reflects over, which TypeScript erases.
   */
  returnType?: string;
}

/** The options every schema-driven builder shares. */
interface BuildFromSchemaBaseOptions {
  vertexai: boolean;
  /** Declared tool name. Required and non-empty. */
  name: string;
  description?: string;
  /** Name of the tool's return type, e.g. `'str'` or `'None'`. */
  returnType?: string;
}

/**
 * Options for {@link buildFunctionDeclarationUtil} and
 * {@link buildFunctionDeclarationFromSchema}.
 */
export interface BuildFunctionDeclarationFromSchemaOptions extends BuildFromSchemaBaseOptions {
  /** A whole schema node; only its `properties` and `required` are read. */
  schema?: JsonSchemaNode;
}

/** Options for {@link buildFunctionDeclarationFromProperties}. */
export interface BuildFunctionDeclarationFromPropertiesOptions extends BuildFromSchemaBaseOptions {
  /** The `properties` map of a schema, without its enclosing node. */
  parameterProperties?: Record<string, JsonSchemaNode>;
}

/**
 * Schema and language type names to genai types, transcribed from
 * adk-python's `_py_type_2_schema_type`.
 */
const SCHEMA_TYPE_BY_NAME: Record<string, Type> = {
  'str': Type.STRING,
  'int': Type.INTEGER,
  'float': Type.NUMBER,
  'bool': Type.BOOLEAN,
  'string': Type.STRING,
  'integer': Type.INTEGER,
  'number': Type.NUMBER,
  'boolean': Type.BOOLEAN,
  'list': Type.ARRAY,
  'array': Type.ARRAY,
  'tuple': Type.ARRAY,
  'object': Type.OBJECT,
  'Dict': Type.OBJECT,
  'List': Type.ARRAY,
  'Tuple': Type.ARRAY,
  'Any': Type.TYPE_UNSPECIFIED,
};

/**
 * The same table keyed by lower-case name, so the upper-case type names
 * `zodObjectToSchema` emits (`'STRING'`, `'ARRAY'`) also resolve.
 */
const SCHEMA_TYPE_BY_LOWERCASE_NAME: Record<string, Type> = Object.fromEntries(
  Object.entries(SCHEMA_TYPE_BY_NAME).map(([name, type]) => [
    name.toLowerCase(),
    type,
  ]),
);

/** The return type names that describe an empty return value. */
const NULL_RETURN_TYPE_NAMES = ['none', 'null'];

/** Resolves a raw type name, exact match first, then case-insensitively. */
function toSchemaType(typeName: string): Type {
  return (
    SCHEMA_TYPE_BY_NAME[typeName] ??
    SCHEMA_TYPE_BY_LOWERCASE_NAME[typeName.toLowerCase()] ??
    Type.TYPE_UNSPECIFIED
  );
}

/**
 * Whether a raw type name means null.
 *
 * The comparison folds case, as the type lookup does. `zodObjectToSchema` and
 * the genai `Type` enum both spell it `'NULL'`, and a union member that is not
 * recognised as the null member erases the property's own type.
 */
function isNullType(typeName: string | undefined): boolean {
  return typeName?.toLowerCase() === 'null';
}

function mapProperties<T>(
  properties: Record<string, JsonSchemaNode>,
  transform: (property: JsonSchemaNode) => T,
): Record<string, T> {
  return Object.fromEntries(
    Object.entries(properties).map(([name, property]) => [
      name,
      transform(property),
    ]),
  );
}

/**
 * `_annotate_nullable_fields`: marks a property whose union admits `null` as
 * nullable and drops that member. Only the first null member is dropped, as in
 * adk-python.
 */
function annotateNullableFields(
  properties: Record<string, JsonSchemaNode>,
): Record<string, JsonSchemaNode> {
  return mapProperties(properties, (property) => {
    const {anyOf = []} = property;
    const nullIndex = anyOf.findIndex((member) => isNullType(member.type));
    if (nullIndex < 0) {
      return {...property};
    }
    return {
      ...property,
      nullable: true,
      anyOf: anyOf.filter((_, index) => index !== nullIndex),
    };
  });
}

/**
 * `_annotate_required_fields`: a property is required when it is not nullable
 * and declares no default. The `default` key is tested for presence, so a
 * property whose default is `null` is still optional.
 *
 * adk-python derives the list from the properties alone, because pydantic
 * marks every optional field with a default. A source that marks a field
 * optional without giving it a default, as Zod does, would otherwise be
 * declared required, so the derived list is narrowed to the list the source
 * declares when it declares one.
 */
function annotateRequiredFields(
  properties: Record<string, JsonSchemaNode>,
  declaredRequired: string[] | undefined,
): string[] {
  return Object.entries(properties)
    .filter(
      ([name, property]) =>
        !property.nullable &&
        !('default' in property) &&
        (declaredRequired === undefined || declaredRequired.includes(name)),
    )
    .map(([name]) => name);
}

/**
 * `_remove_any_of`: merges every non-null union member into the property and
 * drops the union. adk-python's comment says it takes the first member, but its
 * loop has no break, so the last member wins. This ports the code.
 */
function mergeUnionMembers(property: JsonSchemaNode): JsonSchemaNode {
  const merged: JsonSchemaNode = {...property};
  delete merged.anyOf;
  for (const member of property.anyOf ?? []) {
    if (!isNullType(member.type)) {
      Object.assign(merged, member);
    }
  }
  return merged;
}

/**
 * `_remove_any_of`, `_remove_default`, `_remove_nullable` and `_remove_title`:
 * drops the keywords the Gemini Developer API surface rejects.
 */
function stripGeminiApiKeywords(property: JsonSchemaNode): JsonSchemaNode {
  const stripped = mergeUnionMembers(property);
  delete stripped.default;
  delete stripped.nullable;
  delete stripped.title;
  return stripped;
}

/**
 * `_process_pydantic_schema`: normalises a schema's properties and derives its
 * required list.
 *
 * The order is load-bearing. `required` is derived before defaults are
 * stripped, so a defaulted parameter stays optional.
 */
function processJsonSchema(
  vertexai: boolean,
  schema: JsonSchemaNode,
): JsonSchemaNode {
  const properties = annotateNullableFields(schema.properties ?? {});
  return {
    ...schema,
    properties: vertexai
      ? properties
      : mapProperties(properties, stripGeminiApiKeywords),
    required: annotateRequiredFields(properties, schema.required),
  };
}

/**
 * `_map_pydantic_type_to_property_schema`: renders a raw JSON Schema node as a
 * genai {@link Schema} by resolving every type name it carries.
 */
function toGenaiSchema(node: JsonSchemaNode): Schema {
  const {type, items, anyOf, properties, ...rest} = node;
  const schema: Schema = {...rest};
  if (type !== undefined) {
    schema.type = toSchemaType(type);
  }
  if (items !== undefined) {
    schema.items = toGenaiSchema(items);
  }
  if (properties !== undefined) {
    schema.properties = mapProperties(properties, toGenaiSchema);
  }
  if (anyOf !== undefined) {
    schema.anyOf = anyOf.map(toGenaiSchema);
    // A union member's type is hoisted onto the parent because the backend
    // rejects a declaration that carries `anyOf` and no type of its own.
    for (const member of schema.anyOf) {
      if (member.type !== undefined) {
        schema.type = member.type;
      }
    }
  }
  return schema;
}

/**
 * `_get_return_type`: the response schema for a named return type.
 *
 * An absent return type is adk-python's `Any`. The reflection path renders it
 * as a schema with no type at all and the schema path renders it as
 * `TYPE_UNSPECIFIED`, so the caller passes the form it needs.
 */
function mapReturnType(
  returnType: string | undefined,
  absentReturnType: Schema,
): Schema {
  if (returnType === undefined) {
    return absentReturnType;
  }
  if (NULL_RETURN_TYPE_NAMES.includes(returnType.toLowerCase())) {
    return {type: Type.NULL};
  }
  return {type: toSchemaType(returnType)};
}

function assembleDeclaration(
  name: string,
  description: string | undefined,
  schema: JsonSchemaNode,
  response: Schema | undefined,
): FunctionDeclaration {
  if (!name) {
    throw new Error('Function declaration name cannot be empty.');
  }
  const declaration: FunctionDeclaration = {name};
  if (description !== undefined) {
    declaration.description = description;
  }
  const properties = mapProperties(schema.properties ?? {}, toGenaiSchema);
  // A parameterless tool must not advertise an empty OBJECT schema.
  if (Object.keys(properties).length > 0) {
    declaration.parameters = {
      type: Type.OBJECT,
      properties,
      required: schema.required ?? [],
    };
  }
  if (response !== undefined) {
    declaration.response = response;
  }
  return declaration;
}

function toJsonSchemaNode(
  parameters: FunctionDeclarationParameters,
): JsonSchemaNode {
  if (parameters === undefined) {
    return {};
  }
  if (isZodObject(parameters)) {
    return zodObjectToSchema(parameters);
  }
  return parameters;
}

/**
 * Builds a function declaration from an already-normalised schema, mapping
 * every type name it carries.
 *
 * Ports adk-python's `build_function_declaration_util`.
 */
export function buildFunctionDeclarationUtil(
  options: BuildFunctionDeclarationFromSchemaOptions,
): FunctionDeclaration {
  return assembleDeclaration(
    options.name,
    options.description,
    options.schema ?? {},
    options.vertexai
      ? mapReturnType(options.returnType, {type: Type.TYPE_UNSPECIFIED})
      : undefined,
  );
}

/**
 * Builds a function declaration from a whole schema node, normalising its
 * properties for the target API surface first.
 *
 * The node's own top-level keys, such as `title` and `type`, are not mistaken
 * for parameters. Ports adk-python's
 * `build_function_declaration_for_params_for_crewai`.
 */
export function buildFunctionDeclarationFromSchema(
  options: BuildFunctionDeclarationFromSchemaOptions,
): FunctionDeclaration {
  return buildFunctionDeclarationUtil({
    ...options,
    schema: processJsonSchema(options.vertexai, options.schema ?? {}),
  });
}

/**
 * Builds a function declaration from the `properties` map of a schema,
 * normalising it for the target API surface first.
 *
 * Ports adk-python's `build_function_declaration_for_langchain`.
 */
export function buildFunctionDeclarationFromProperties(
  options: BuildFunctionDeclarationFromPropertiesOptions,
): FunctionDeclaration {
  const {parameterProperties, ...rest} = options;
  return buildFunctionDeclarationUtil({
    ...rest,
    schema: processJsonSchema(options.vertexai, {
      properties: parameterProperties,
    }),
  });
}

/**
 * Builds a function declaration for a tool from its parameter schema.
 *
 * Ports adk-python's `build_function_declaration`. adk-python reflects the
 * parameter list and the return annotation off the function object; TypeScript
 * erases both, so this takes the schema and the return type name as arguments.
 */
export function buildFunctionDeclaration(
  options: BuildFunctionDeclarationOptions,
): FunctionDeclaration {
  const variant = options.variant ?? GoogleLLMVariant.GEMINI_API;
  const vertexai = variant === GoogleLLMVariant.VERTEX_AI;
  const parameters = toJsonSchemaNode(options.parameters);
  const ignoreParams = options.ignoreParams ?? [];
  const properties = Object.fromEntries(
    Object.entries(parameters.properties ?? {}).filter(
      ([name]) => !ignoreParams.includes(name),
    ),
  );
  return assembleDeclaration(
    options.name,
    options.description,
    processJsonSchema(vertexai, {...parameters, properties}),
    vertexai ? mapReturnType(options.returnType, {}) : undefined,
  );
}
