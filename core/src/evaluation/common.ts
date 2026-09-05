/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {z} from 'zod';
import {InputValidationError} from '../errors/input_validation_error.js';
import {isRecord, toSnakeCaseKey} from '../utils/object_notation_utils.js';

/** How an eval model treats a key its shape does not name. */
export type ExtraKeysPolicy = 'forbid' | 'allow';

/** Options for {@link evalModel}. */
export interface EvalModelOptions {
  /** The model name, used in validation error messages. */
  readonly name: string;

  /**
   * Whether an unrecognized key is an error. Defaults to `'forbid'`, matching
   * adk-python's `EvalBaseModel`. `'allow'` keeps the key, matching
   * `BaseCriterion`.
   */
  readonly extraKeys?: ExtraKeysPolicy;
}

/** An evaluation model: the shared validation configuration, applied. */
export interface EvalModel<T extends object> {
  /**
   * The underlying schema, so one model can be a field of another, and so a
   * caller can validate without throwing through `schema.safeParse`.
   */
  readonly schema: z.ZodType<T>;

  /**
   * Validates a value against the model.
   *
   * @throws {InputValidationError} If the value is not a valid `T`.
   */
  parse(raw: unknown): T;
}

/**
 * Wraps a schema as an optional field that also accepts an explicit `null`.
 *
 * adk-python declares these fields `Optional[...]`, so it writes `null` where
 * the value is absent. Both spellings read back as `undefined`.
 */
export function optionalField<T extends NonNullable<unknown>>(
  schema: z.ZodType<T>,
): z.ZodType<T | undefined> {
  return schema.nullish().transform((value) => value ?? undefined);
}

/**
 * Builds an evaluation model from a field shape.
 *
 * Every evaluation model shares one validation configuration, the counterpart
 * of adk-python's `EvalBaseModel`: canonical property names are camelCase,
 * both spellings are accepted on the wire, and an unrecognized key is an error
 * rather than a silently dropped field unless {@link
 * EvalModelOptions.extraKeys} allows it. A field declared with `z.custom`
 * holds a value the schema does not describe and passes it through by
 * reference, which is what adk-python's `arbitrary_types_allowed` does.
 */
export function evalModel<Shape extends z.ZodRawShape>(
  shape: Shape,
  options: EvalModelOptions,
): EvalModel<z.infer<z.ZodObject<Shape>>> {
  const properties = new Map<string, string>();
  for (const property of Object.keys(shape)) {
    properties.set(toSnakeCaseKey(property), property);
  }

  const object =
    options.extraKeys === 'allow'
      ? z.looseObject(shape)
      : z.strictObject(shape);
  const schema = z.preprocess(
    (raw) => (isRecord(raw) ? renameKeys(raw, properties) : raw),
    object,
  );

  return {
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
  };
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
