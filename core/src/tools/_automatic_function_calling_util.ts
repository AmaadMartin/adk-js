/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {FunctionDeclaration, Schema, Type} from '@google/genai';
import {zodToJsonSchema as toJSONSchemaV3} from 'zod-to-json-schema';
import {z as z3} from 'zod/v3';
import {toJSONSchema as toJSONSchemaV4, z as z4} from 'zod/v4';

import {FeatureName, isFeatureEnabled} from '../features/feature_registry.js';
import {formatError} from '../utils/error_utils.js';
import {logger} from '../utils/logger.js';
import {SchemaLike} from '../utils/schema.js';
import {sanitizeJsonSchemaForGemini} from '../utils/schema_variant_utils.js';
import {
  isZodObject,
  isZodSchema,
  isZodV3Schema,
  isZodV4Schema,
  zodObjectToSchema,
} from '../utils/simple_zod_to_json.js';
import {GoogleLLMVariant} from '../utils/variant_utils.js';
import {
  buildFunctionDeclarationWithJsonSchema,
  CONTEXT_PARAMETER_NAMES,
  isNullReturnTypeName,
  toSchemaType,
  unwrapReturnTypeName,
} from './_function_tool_declarations.js';

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
  /**
   * A schema for the return value, for a return type no type name can express.
   * Takes precedence over `returnType`.
   */
  returnSchema?: SchemaLike | JsonSchemaNode;
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
 * A streaming return type declares its yield type, so the name is unwrapped
 * before it is resolved. An absent return type is adk-python's `Any`: the
 * reflection path renders it as a schema with no type at all and the schema
 * path renders it as `TYPE_UNSPECIFIED`, so the caller passes the form it
 * needs.
 */
function mapReturnType(
  returnType: string | undefined,
  absentReturnType: Schema,
): Schema {
  if (returnType === undefined) {
    return absentReturnType;
  }
  const typeName = unwrapReturnTypeName(returnType);
  if (isNullReturnTypeName(typeName)) {
    return {type: Type.NULL};
  }
  return {type: toSchemaType(typeName)};
}

/**
 * The genai `parameters` schema for a normalised node, or `undefined` when the
 * node declares no property: a parameterless tool must not advertise an empty
 * OBJECT schema.
 */
function toParametersSchema(schema: JsonSchemaNode): Schema | undefined {
  const properties = mapProperties(schema.properties ?? {}, toGenaiSchema);
  if (Object.keys(properties).length === 0) {
    return undefined;
  }
  return {
    type: Type.OBJECT,
    properties,
    required: schema.required ?? [],
  };
}

function assembleDeclaration(
  name: string,
  description: string | undefined,
  parameters: Schema | undefined,
  response: Schema | undefined,
): FunctionDeclaration {
  if (!name) {
    throw new Error('Function declaration name cannot be empty.');
  }
  const declaration: FunctionDeclaration = {name};
  if (description !== undefined) {
    declaration.description = description;
  }
  if (parameters !== undefined) {
    declaration.parameters = parameters;
  }
  if (response !== undefined) {
    declaration.response = response;
  }
  return declaration;
}

/**
 * Renders a schema source as a JSON Schema node with the strict converter.
 *
 * Only a Zod object has a strict rendering; every other Zod schema is left to
 * {@link lenientSchemaNode}.
 */
function strictSchemaNode(source: SchemaLike | JsonSchemaNode): JsonSchemaNode {
  if (isZodObject(source)) {
    return zodObjectToSchema(source);
  }
  if (isZodSchema(source)) {
    throw new Error('Only a Zod object renders as a genai Schema directly.');
  }
  return readJsonSchemaNode(source);
}

/**
 * Count and length bounds, which the genai `Schema` dialect sends as strings
 * and a JSON Schema document sends as numbers.
 */
const GENAI_STRING_BOUND_KEYS: ReadonlySet<string> = new Set([
  'minItems',
  'maxItems',
  'minLength',
  'maxLength',
  'minProperties',
  'maxProperties',
]);

/**
 * Reads a plain JSON Schema document as a {@link JsonSchemaNode}, stringifying
 * the bounds the two dialects spell differently.
 *
 * adk-python coerces the same fields when it validates a fallback document
 * into a `types.Schema`. Anything else is copied through, so the reader is
 * total: a document it does not recognise still produces a node.
 */
function readJsonSchemaNode(document: unknown): JsonSchemaNode {
  if (
    document === null ||
    typeof document !== 'object' ||
    Array.isArray(document)
  ) {
    return {};
  }
  const node: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(document)) {
    if (GENAI_STRING_BOUND_KEYS.has(key) && typeof value === 'number') {
      node[key] = String(value);
    } else if (key === 'items') {
      node[key] = readJsonSchemaNode(value);
    } else if (key === 'anyOf' && Array.isArray(value)) {
      node[key] = value.map(readJsonSchemaNode);
    } else if (
      key === 'properties' &&
      value !== null &&
      typeof value === 'object'
    ) {
      node[key] = Object.fromEntries(
        Object.entries(value).map(([name, property]) => [
          name,
          readJsonSchemaNode(property),
        ]),
      );
    } else {
      node[key] = value;
    }
  }
  return node as JsonSchemaNode;
}

/**
 * Renders a schema source as a JSON Schema node with the lenient converter.
 *
 * `zodObjectToSchema` refuses a schema that has no JSON Schema form, such as a
 * `z.date()` or `z.custom()` property, and that refusal would otherwise fail
 * the whole declaration. The lenient converter renders the offending property
 * as an unconstrained schema instead. It targets the same OpenAPI dialect the
 * strict converter does, so the two documents differ only where the strict one
 * refuses.
 */
function lenientSchemaNode(
  source: SchemaLike | JsonSchemaNode,
  vertexai: boolean,
): JsonSchemaNode {
  const node = readJsonSchemaNode(toLenientDocument(source));
  // Vertex AI accepts the full OpenAPI `format` vocabulary, so the document
  // reaches it untouched; the Gemini Developer API rejects most of it.
  return vertexai
    ? node
    : readJsonSchemaNode(sanitizeJsonSchemaForGemini(node));
}

/** Converts a Zod schema leniently; any other source is already a document. */
function toLenientDocument(source: SchemaLike | JsonSchemaNode): unknown {
  if (isZodV4Schema(source)) {
    return toJSONSchemaV4(source, {
      target: 'openapi-3.0',
      io: 'input',
      unrepresentable: 'any',
    });
  }
  if (isZodV3Schema(source)) {
    return toJSONSchemaV3(source, {target: 'openApi3'});
  }
  return source;
}

/** Renders a schema source strictly, and leniently when that is refused. */
function toSchemaNode(
  source: SchemaLike | JsonSchemaNode,
  vertexai: boolean,
): JsonSchemaNode {
  try {
    return strictSchemaNode(source);
  } catch {
    return lenientSchemaNode(source, vertexai);
  }
}

/**
 * The genai `parameters` schema for a tool, with the context parameters and
 * the caller's ignored parameters removed.
 *
 * Removing a property removes it from `required` too, because
 * {@link annotateRequiredFields} derives that list from the properties that
 * survive.
 */
function buildParametersSchema(
  options: BuildFunctionDeclarationOptions,
  vertexai: boolean,
): Schema | undefined {
  try {
    const node = toSchemaNode(options.parameters ?? {}, vertexai);
    const ignored = new Set([
      ...CONTEXT_PARAMETER_NAMES,
      ...(options.ignoreParams ?? []),
    ]);
    const properties = Object.fromEntries(
      Object.entries(node.properties ?? {}).filter(
        ([name]) => !ignored.has(name),
      ),
    );
    return toParametersSchema(
      processJsonSchema(vertexai, {...node, properties}),
    );
  } catch (error: unknown) {
    throw new Error(
      `Failed to parse the parameters of function ${options.name} for` +
        ' automatic function calling. Automatic function calling works best' +
        ' with a simpler parameter schema; consider building the declaration' +
        ` for function ${options.name} manually.`,
      {cause: error},
    );
  }
}

/**
 * The genai `response` schema for a tool.
 *
 * A return schema neither converter can render degrades to no response schema
 * at all, with one warning: adk-python never lets a return type fail a
 * declaration whose parameters are valid.
 */
function buildResponseSchema(
  options: BuildFunctionDeclarationOptions,
  vertexai: boolean,
): Schema | undefined {
  const {returnSchema} = options;
  if (returnSchema === undefined) {
    return mapReturnType(options.returnType, {});
  }
  let originalError: unknown;
  try {
    return toGenaiSchema(strictSchemaNode(returnSchema));
  } catch (error: unknown) {
    originalError = error;
  }
  try {
    return toGenaiSchema(lenientSchemaNode(returnSchema, vertexai));
  } catch (error: unknown) {
    logger.warn(
      `Could not build a response schema for ${options.name}; omitting it.` +
        ` Fallback error: ${formatError(error)}.` +
        ` Original error: ${formatError(originalError)}.`,
    );
    return undefined;
  }
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
    toParametersSchema(options.schema ?? {}),
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
  if (isFeatureEnabled(FeatureName.JSON_SCHEMA_FOR_FUNC_DECL)) {
    const declaration = buildFunctionDeclarationWithJsonSchema({
      ...options,
      variant,
    });
    // The Gemini Developer API does not accept `responseJsonSchema` yet, and
    // a serialized declaration must not carry the key at all.
    if (variant !== GoogleLLMVariant.VERTEX_AI) {
      delete declaration.responseJsonSchema;
    }
    return declaration;
  }
  const vertexai = variant === GoogleLLMVariant.VERTEX_AI;
  return assembleDeclaration(
    options.name,
    options.description,
    buildParametersSchema(options, vertexai),
    vertexai ? buildResponseSchema(options, vertexai) : undefined,
  );
}
