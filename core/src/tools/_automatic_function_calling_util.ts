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

/** A schema's properties after normalisation, with its required list. */
interface NormalizedSchema {
  properties: Record<string, JsonSchemaNode>;
  required: string[];
}

/**
 * Schema and language type names to genai types, transcribed from
 * adk-python's `_py_type_2_schema_type`.
 *
 * The keys are lower case and a lookup folds case, because `zodObjectToSchema`
 * and the genai `Type` enum both upper-case type names. No key in adk-python's
 * table collides once folded.
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
  'dict': Type.OBJECT,
  'any': Type.TYPE_UNSPECIFIED,
};

/** Resolves a raw type name; an unknown name is left unspecified. */
function toSchemaType(typeName: string): Type {
  return SCHEMA_TYPE_BY_NAME[typeName.toLowerCase()] ?? Type.TYPE_UNSPECIFIED;
}

/**
 * Whether a raw type name means null.
 *
 * A union member that is not recognised as the null member erases the
 * property's own type, and `zodObjectToSchema` spells it `'NULL'`.
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
 * required list. It takes the properties alone, so the schema's other
 * top-level keys cannot be mistaken for parameters.
 *
 * The order is load-bearing. `required` is derived before defaults are
 * stripped, so a defaulted parameter stays optional.
 */
function processJsonSchema(
  vertexai: boolean,
  properties: Record<string, JsonSchemaNode>,
  declaredRequired: string[] | undefined,
): NormalizedSchema {
  const annotated = annotateNullableFields(properties);
  return {
    properties: vertexai
      ? annotated
      : mapProperties(annotated, stripGeminiApiKeywords),
    required: annotateRequiredFields(annotated, declaredRequired),
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
 * An absent return type is adk-python's `Any`, which it renders as a schema
 * with no type at all.
 */
function mapReturnType(returnType: string | undefined): Schema {
  if (returnType === undefined) {
    return {};
  }
  // adk-python spells the empty return type `None`.
  if (isNullType(returnType) || returnType.toLowerCase() === 'none') {
    return {type: Type.NULL};
  }
  return {type: toSchemaType(returnType)};
}

function toJsonSchemaNode(
  parameters: FunctionDeclarationParameters,
): JsonSchemaNode {
  if (parameters === undefined) {
    return {};
  }
  if (isZodObject(parameters)) {
    const schema = zodObjectToSchema(parameters);
    // Zod marks a property optional without giving it a default, so its
    // required list is the only signal, and `zodObjectToSchema` omits that list
    // when it would be empty. An absent list therefore means no property is
    // required, not that the source declared nothing.
    return {...schema, required: schema.required ?? []};
  }
  return parameters;
}

/**
 * Builds a function declaration for a tool from its parameter schema,
 * normalising the schema for the target API surface.
 *
 * A schema a tool wrapper already owns still carries `title`, `default` and
 * `anyOf: [T, null]`, which the Gemini Developer API rejects. They are
 * stripped for that variant and kept for Vertex AI.
 *
 * Ports adk-python's `build_function_declaration`,
 * `build_function_declaration_util`, `build_function_declaration_for_langchain`
 * and `build_function_declaration_for_params_for_crewai`, which differ only in
 * the shape of the arguments they take. adk-python reflects the parameter list
 * and the return annotation off the function object; TypeScript erases both, so
 * this takes the schema and the return type name as arguments.
 */
export function buildFunctionDeclaration(
  options: BuildFunctionDeclarationOptions,
): FunctionDeclaration {
  if (!options.name) {
    throw new Error('Function declaration name cannot be empty.');
  }
  const vertexai =
    (options.variant ?? GoogleLLMVariant.GEMINI_API) ===
    GoogleLLMVariant.VERTEX_AI;
  const source = toJsonSchemaNode(options.parameters);
  const ignoreParams = options.ignoreParams ?? [];
  const normalized = processJsonSchema(
    vertexai,
    Object.fromEntries(
      Object.entries(source.properties ?? {}).filter(
        ([name]) => !ignoreParams.includes(name),
      ),
    ),
    source.required,
  );

  const declaration: FunctionDeclaration = {name: options.name};
  if (options.description !== undefined) {
    declaration.description = options.description;
  }
  const properties = mapProperties(normalized.properties, toGenaiSchema);
  // A parameterless tool must not advertise an empty OBJECT schema.
  if (Object.keys(properties).length > 0) {
    declaration.parameters = {
      type: Type.OBJECT,
      properties,
      required: normalized.required,
    };
  }
  if (vertexai) {
    declaration.response = mapReturnType(options.returnType);
  }
  return declaration;
}
