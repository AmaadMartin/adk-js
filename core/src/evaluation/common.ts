/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {z} from 'zod';
import {InputValidationError} from '../errors/input_validation_error.js';
import {toSnakeCaseKey} from '../utils/object_notation_utils.js';

/** How an eval model treats a key its shape does not name. */
export type ExtraKeysPolicy = 'forbid' | 'allow';

/** Options that decide how an eval model reads its input. */
export interface EvalModelOptions {
  /** Used in validation error messages. */
  readonly name: string;

  /**
   * Whether an unrecognized key is an error. Defaults to `'forbid'`, matching
   * adk-python's `EvalBaseModel`. `'allow'` keeps the key, matching
   * `BaseCriterion`.
   */
  readonly extraKeys?: ExtraKeysPolicy;
}

/** A validated eval data model. */
export interface EvalModel<T extends object> {
  /** The schema, for embedding this model inside another one. */
  readonly schema: z.ZodType<T>;

  /**
   * Validates a raw payload and applies every default.
   *
   * @throws {InputValidationError} When the payload does not satisfy the
   *   schema. Its `cause` is the underlying `ZodError`.
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function propertiesByAlias(shape: z.ZodRawShape): ReadonlyMap<string, string> {
  const byAlias = new Map<string, string>();
  for (const property of Object.keys(shape)) {
    const alias = toSnakeCaseKey(property);
    if (alias !== property) {
      byAlias.set(alias, property);
    }
  }
  return byAlias;
}

/**
 * Renames the alias keys of a payload to their canonical property names.
 *
 * A key keeps its own spelling when the canonical spelling is already present,
 * so a payload supplying both surfaces as an unrecognized key instead of
 * silently losing one of the two values.
 */
function renameAliasesToProperties(
  raw: unknown,
  propertyByAlias: ReadonlyMap<string, string>,
): unknown {
  if (!isRecord(raw)) {
    return raw;
  }

  const renamed: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw)) {
    const property = propertyByAlias.get(key);
    const target =
      property !== undefined && !(property in raw) ? property : key;
    renamed[target] = value;
  }
  return renamed;
}

function formatIssues(name: string, error: z.ZodError): string {
  const issues = error.issues.map((issue) =>
    issue.path.length > 0
      ? `${issue.path.join('.')}: ${issue.message}`
      : issue.message,
  );
  return `Invalid ${name}: ${issues.join('; ')}`;
}

/**
 * Builds an eval data model from a zod field shape.
 *
 * This is the TypeScript counterpart of adk-python's `EvalBaseModel`: the
 * canonical property names are camelCase, the snake_case spelling adk-python
 * writes is accepted on input, and an unrecognized key is rejected unless
 * {@link EvalModelOptions.extraKeys} allows it.
 */
export function evalModel<Shape extends z.ZodRawShape>(
  shape: Shape,
  options: EvalModelOptions,
): EvalModel<z.infer<z.ZodObject<Shape>>> {
  const propertyByAlias = propertiesByAlias(shape);
  const object =
    options.extraKeys === 'allow'
      ? z.looseObject(shape)
      : z.strictObject(shape);
  const schema: z.ZodType<z.infer<z.ZodObject<Shape>>> = z.preprocess(
    (raw) => renameAliasesToProperties(raw, propertyByAlias),
    object,
  );

  return {
    schema,
    parse(raw: unknown): z.infer<z.ZodObject<Shape>> {
      const result = schema.safeParse(raw);
      if (!result.success) {
        throw new InputValidationError(
          formatIssues(options.name, result.error),
          {cause: result.error},
        );
      }
      return result.data;
    },
  };
}
