/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {z} from 'zod';
import {InputValidationError} from '../errors/input_validation_error.js';
import {toSnakeCaseKey} from '../utils/object_notation_utils.js';

/**
 * The wire alias of a canonical property name.
 *
 * The alias is the snake_case spelling, which is what adk-python writes. A
 * digit segment does not survive the round trip: adk-python aliases
 * `metric_name_1` to `metricName1`, whose snake_case form is `metric_name1`.
 * Pass {@link EvalModelOptions.aliases} for a field whose name has one.
 */
export function evalAlias(propertyName: string): string {
  return toSnakeCaseKey(propertyName);
}

/** Options for {@link evalModel}. */
export interface EvalModelOptions {
  /** The model name, used in validation error messages. */
  readonly name: string;

  /**
   * Wire aliases for fields whose alias is not {@link evalAlias} of the
   * property name.
   */
  readonly aliases?: Readonly<Record<string, string>>;
}

/** Options for {@link EvalModel.dump}. */
export interface EvalDumpOptions {
  /** Emits snake_case alias keys instead of the canonical camelCase ones. */
  readonly byAlias?: boolean;
}

/** An evaluation model: the shared validation configuration, applied. */
export interface EvalModel<T extends object> {
  /** The model name, used in validation error messages. */
  readonly name: string;

  /** Property name to wire alias, for every declared field. */
  readonly aliases: ReadonlyMap<string, string>;

  /** The underlying schema, so one model can be a field of another. */
  readonly schema: z.ZodType<T>;

  /**
   * Validates a value against the model.
   *
   * @throws {InputValidationError} If the value is not a valid `T`.
   */
  parse(raw: unknown): T;

  /** Validates a value against the model without throwing. */
  safeParse(raw: unknown): z.ZodSafeParseResult<T>;

  /** Renders a validated value as JSON. */
  dump(value: T, options?: EvalDumpOptions): Record<string, unknown>;
}

/**
 * Builds an evaluation model from a field shape.
 *
 * Every evaluation model shares one validation configuration, the counterpart
 * of adk-python's `EvalBaseModel`: canonical property names are camelCase,
 * both spellings are accepted on the wire, and an unrecognized key is an error
 * rather than a silently dropped field.
 */
export function evalModel<Shape extends z.ZodRawShape>(
  shape: Shape,
  options: EvalModelOptions,
): EvalModel<z.infer<z.ZodObject<Shape>>> {
  const aliases = new Map<string, string>();
  for (const property of Object.keys(shape)) {
    aliases.set(property, options.aliases?.[property] ?? evalAlias(property));
  }
  const properties = new Map<string, string>();
  for (const [property, alias] of aliases) {
    properties.set(alias, property);
  }

  const schema = z
    .codec(z.looseObject({}), z.looseObject({}), {
      decode: (raw) => renameKeys(raw, properties),
      encode: (value) => renameKeys(value, aliases),
    })
    .pipe(z.strictObject(shape));

  return {
    name: options.name,
    aliases,
    schema,
    parse(raw) {
      const result = schema.safeParse(raw);
      if (!result.success) {
        throw new InputValidationError(
          `Invalid ${options.name}: ${describeIssues(result.error)}`,
          {cause: result.error},
        );
      }
      return result.data;
    },
    safeParse(raw) {
      return schema.safeParse(raw);
    },
    dump(value, dumpOptions) {
      return dumpOptions?.byAlias ? schema.encode(value) : toRecord(value);
    },
  };
}

/**
 * A field holding a value the eval models carry but do not describe, the
 * counterpart of adk-python's `arbitrary_types_allowed`.
 *
 * The value passes through by reference. Supply `check` to constrain it.
 */
export function arbitraryType<T>(
  check?: (value: unknown) => boolean,
): z.ZodType<T> {
  return z.custom<T>(check);
}

/**
 * Renames the keys of `source` through `replacements`.
 *
 * A key keeps its spelling when the replacement is already present, so an
 * alias populates a field only if the canonical spelling is absent. Supplying
 * both spellings therefore leaves the alias in place, and the strict object
 * reports it as an unrecognized key.
 */
function renameKeys(
  source: Record<string, unknown>,
  replacements: ReadonlyMap<string, string>,
): Record<string, unknown> {
  const renamed: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(source)) {
    const replacement = replacements.get(key);
    const rename = replacement !== undefined && !(replacement in source);
    renamed[rename ? replacement : key] = value;
  }
  return renamed;
}

/** Summarizes a validation failure, naming the property of each problem. */
function describeIssues(error: z.ZodError): string {
  return error.issues
    .map((issue) =>
      issue.path.length > 0
        ? `${issue.path.join('.')}: ${issue.message}`
        : issue.message,
    )
    .join('; ');
}

/** Copies an object's own enumerable properties into a plain record. */
function toRecord(value: object): Record<string, unknown> {
  return {...value};
}
