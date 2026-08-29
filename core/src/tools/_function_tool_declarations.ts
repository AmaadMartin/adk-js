/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Builds a function declaration whose parameters and response are raw JSON
 * Schema documents, plus the type-name helpers the genai-`Schema` builder in
 * `_automatic_function_calling_util.ts` shares with it.
 *
 * Ports adk-python's `_function_tool_declarations.py`. The genai SDK accepts
 * `parametersJsonSchema` and `responseJsonSchema` natively, so this path hands
 * the schema over untranslated instead of rewriting it into the genai dialect.
 *
 * This module is for ADK internal use only.
 */

import {FunctionDeclaration, Schema, Type} from '@google/genai';
import {zodToJsonSchema as toJSONSchemaV3} from 'zod-to-json-schema';
import {toJSONSchema as toJSONSchemaV4} from 'zod/v4';

import {formatError} from '../utils/error_utils.js';
import {genaiSchemaToJsonSchema} from '../utils/genai_schema_to_json.js';
import {logger} from '../utils/logger.js';
import {SchemaLike} from '../utils/schema.js';
import {flattenNullableAnyOf} from '../utils/schema_variant_utils.js';
import {isZodV3Schema, isZodV4Schema} from '../utils/simple_zod_to_json.js';
import {getGoogleLlmVariant, GoogleLLMVariant} from '../utils/variant_utils.js';
// Type-only, so the two modules do not depend on each other at runtime: the
// value dependency runs from `_automatic_function_calling_util.ts` to here.
import type {
  FunctionDeclarationParameters,
  JsonSchemaNode,
} from './_automatic_function_calling_util.js';

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

/**
 * Property names that carry a tool context rather than a model argument.
 *
 * adk-python inspects the parameter's annotation and falls back to the name
 * `tool_context`. A name is the only signal TypeScript leaves at runtime, so
 * this list holds the two names ADK itself uses.
 */
export const CONTEXT_PARAMETER_NAMES: readonly string[] = [
  'toolContext',
  'tool_context',
];

/**
 * Generic wrappers whose first type argument is the value a tool actually
 * produces.
 *
 * `Promise` is the TypeScript-idiomatic addition to adk-python's list: a
 * JavaScript tool returns `Promise<T>` where a Python coroutine annotates `T`.
 */
const RETURN_TYPE_WRAPPERS: ReadonlySet<string> = new Set([
  'AsyncGenerator',
  'Generator',
  'AsyncIterable',
  'Iterable',
  'AsyncIterator',
  'Iterator',
  'Promise',
]);

/** Bounds {@link unwrapReturnTypeName} against a pathologically nested name. */
const MAX_RETURN_TYPE_UNWRAPS = 8;

/** Resolves a raw type name, exact match first, then case-insensitively. */
export function toSchemaType(typeName: string): Type {
  return (
    SCHEMA_TYPE_BY_NAME[typeName] ??
    SCHEMA_TYPE_BY_LOWERCASE_NAME[typeName.toLowerCase()] ??
    Type.TYPE_UNSPECIFIED
  );
}

/** Whether a return type name describes an empty return value. */
export function isNullReturnTypeName(typeName: string): boolean {
  return NULL_RETURN_TYPE_NAMES.includes(typeName.toLowerCase());
}

/** A type name split into its bare name and its first type argument. */
interface GenericTypeName {
  name: string;
  argument: string;
}

/** The first entry of a type argument list, ignoring nested commas. */
function firstTypeArgument(text: string): string {
  let depth = 0;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (character === '<' || character === '[') {
      depth += 1;
    } else if (character === '>' || character === ']') {
      depth -= 1;
    } else if (character === ',' && depth === 0) {
      return text.slice(0, index).trim();
    }
  }
  return text.trim();
}

/**
 * Reads a type name as a bare name plus its type arguments, accepting both the
 * TypeScript spelling (`Wrapper<A, B>`) and the Python one (`Wrapper[A, B]`).
 *
 * Returns `undefined` when the name carries no argument list.
 */
function parseGenericTypeName(text: string): GenericTypeName | undefined {
  const open = text.search(/[<[]/);
  if (open < 0) {
    return undefined;
  }
  const close = text.lastIndexOf(text[open] === '<' ? '>' : ']');
  const name = text.slice(0, open).trim();
  if (close <= open || !name) {
    return undefined;
  }
  return {name, argument: firstTypeArgument(text.slice(open + 1, close))};
}

/**
 * Reduces a return type name to the type a tool call actually yields.
 *
 * A streaming tool declares its yield type as its response, so
 * `AsyncGenerator<string, void>` becomes `string`, exactly as adk-python takes
 * the first type argument of `AsyncGenerator` and `Generator`. Any remaining
 * argument list is dropped, so `Dict[str, str]` resolves as `Dict`.
 */
export function unwrapReturnTypeName(typeName: string): string {
  let current = typeName.trim();
  for (let unwraps = 0; unwraps < MAX_RETURN_TYPE_UNWRAPS; unwraps += 1) {
    const generic = parseGenericTypeName(current);
    if (generic === undefined) {
      return current;
    }
    if (!RETURN_TYPE_WRAPPERS.has(generic.name)) {
      return generic.name;
    }
    current = generic.argument;
  }
  return current;
}

/**
 * Removes the blank edges of a description and the common indent of its second
 * and further lines, as Python's `inspect.cleandoc` does for a docstring.
 */
export function cleanDescription(description: string): string {
  const lines = description.split('\n');
  const indents = lines
    .slice(1)
    .filter((line) => line.trim() !== '')
    .map((line) => line.length - line.trimStart().length);
  const margin = indents.length > 0 ? Math.min(...indents) : 0;
  const cleaned = lines.map((line, index) =>
    index === 0 ? line.replace(/^\s+/, '') : line.slice(margin),
  );
  while (cleaned.length > 0 && cleaned[0].trim() === '') {
    cleaned.shift();
  }
  while (cleaned.length > 0 && cleaned[cleaned.length - 1].trim() === '') {
    cleaned.pop();
  }
  return cleaned.join('\n');
}

/** Options for {@link buildFunctionDeclarationWithJsonSchema}. */
export interface BuildJsonSchemaDeclarationOptions {
  /** Declared tool name. Required and non-empty. */
  name: string;
  description?: string;
  parameters?: FunctionDeclarationParameters;
  /** Parameter names to drop, on top of {@link CONTEXT_PARAMETER_NAMES}. */
  ignoreParams?: string[];
  /** Name of the tool's return type, e.g. `'str'` or `'AsyncGenerator<str>'`. */
  returnType?: string;
  /** A schema for the return value. Takes precedence over `returnType`. */
  returnSchema?: SchemaLike | JsonSchemaNode;
  variant?: GoogleLLMVariant;
}

/**
 * Renders a schema source as a plain JSON Schema document.
 *
 * A Zod schema is read in its input direction, so a property with a default is
 * optional for the model that fills the schema in. A source with no JSON
 * Schema form, such as a `z.date()` property, is refused here: adk-python
 * refuses the same parameter and degrades the same return type.
 */
function toJsonSchemaDocument(
  source: SchemaLike | JsonSchemaNode,
): Record<string, unknown> {
  if (isZodV4Schema(source)) {
    return toJSONSchemaV4(source, {io: 'input'}) as Record<string, unknown>;
  }
  if (isZodV3Schema(source)) {
    return toJSONSchemaV3(source) as Record<string, unknown>;
  }
  return genaiSchemaToJsonSchema(source as Schema);
}

/**
 * The parameters document for a declaration, or `undefined` when no parameter
 * survives the ignore list.
 *
 * adk-python omits `parameters_json_schema` for a tool that declares no
 * parameter rather than sending an empty object.
 */
function buildParametersJsonSchema(
  source: FunctionDeclarationParameters,
  ignoreParams: string[] | undefined,
  variant: GoogleLLMVariant,
): Record<string, unknown> | undefined {
  if (source === undefined) {
    return undefined;
  }
  const document = toJsonSchemaDocument(source);
  delete document['$schema'];

  const ignored = new Set([
    ...CONTEXT_PARAMETER_NAMES,
    ...(ignoreParams ?? []),
  ]);
  const declared = document['properties'];
  const properties = Object.fromEntries(
    Object.entries(
      declared !== null && typeof declared === 'object'
        ? (declared as Record<string, unknown>)
        : {},
    ).filter(([name]) => !ignored.has(name)),
  );
  if (Object.keys(properties).length === 0) {
    return undefined;
  }
  document['properties'] = properties;
  if (Array.isArray(document['required'])) {
    document['required'] = document['required'].filter(
      (name) => typeof name === 'string' && name in properties,
    );
  }
  return variant === GoogleLLMVariant.VERTEX_AI
    ? flattenNullableAnyOf(document)
    : document;
}

/**
 * The response document for a declaration, or `undefined` when the tool
 * declares no return value.
 *
 * A schema that cannot be rendered degrades to no response schema at all, with
 * one warning: adk-python never lets a return type fail a declaration whose
 * parameters are valid.
 */
function buildResponseJsonSchema(
  name: string,
  returnSchema: SchemaLike | JsonSchemaNode | undefined,
  returnType: string | undefined,
  variant: GoogleLLMVariant,
): Record<string, unknown> | undefined {
  if (returnSchema !== undefined) {
    let document: Record<string, unknown>;
    try {
      document = toJsonSchemaDocument(returnSchema);
    } catch (error: unknown) {
      logger.warn(
        `Could not build a response schema for ${name}; omitting it.` +
          ` Error: ${formatError(error)}.`,
      );
      return undefined;
    }
    delete document['$schema'];
    return variant === GoogleLLMVariant.VERTEX_AI
      ? flattenNullableAnyOf(document)
      : document;
  }
  if (returnType === undefined) {
    return undefined;
  }
  const typeName = unwrapReturnTypeName(returnType);
  if (isNullReturnTypeName(typeName)) {
    return {type: 'null'};
  }
  const type = toSchemaType(typeName);
  return type === Type.TYPE_UNSPECIFIED ? {} : {type: type.toLowerCase()};
}

/**
 * Builds a function declaration whose schemas are raw JSON Schema documents.
 *
 * Ports adk-python's `build_function_declaration_with_json_schema`. The caller
 * decides whether the response schema survives: the Gemini Developer API does
 * not accept `responseJsonSchema` yet.
 */
export function buildFunctionDeclarationWithJsonSchema(
  options: BuildJsonSchemaDeclarationOptions,
): FunctionDeclaration {
  if (!options.name) {
    throw new Error('Function declaration name cannot be empty.');
  }
  const variant = options.variant ?? getGoogleLlmVariant();
  const declaration: FunctionDeclaration = {name: options.name};
  if (options.description !== undefined) {
    declaration.description = cleanDescription(options.description);
  }
  const parameters = buildParametersJsonSchema(
    options.parameters,
    options.ignoreParams,
    variant,
  );
  if (parameters !== undefined) {
    declaration.parametersJsonSchema = parameters;
  }
  const response = buildResponseJsonSchema(
    options.name,
    options.returnSchema,
    options.returnType,
    variant,
  );
  if (response !== undefined) {
    declaration.responseJsonSchema = response;
  }
  return declaration;
}
