/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Type-level conformance checks for the *published* type surface of
 * `@google/adk`, typechecked against `core/dist/types` (the declarations that
 * ship to npm) rather than `core/src`.
 *
 * Declaration emit erases the types of `private` members, so a generic that
 * only private members reference disappears from the shipped `.d.ts` and stops
 * constraining consumers.
 */

import type {
  FunctionTool,
  LongRunningFunctionTool,
  ToolInputParameters,
} from '@google/adk';
import type {z} from 'zod';

type Params = z.ZodObject<{a: z.ZodString}>;

/** Resolves to `true` if and only if `TFrom` is assignable to `TTo`. */
type AssignableTo<TFrom, TTo> = [TFrom] extends [TTo] ? true : false;

/** Fails to compile unless `T` is `true`. */
type Assert<T extends true> = T;

/** Fails to compile unless `T` is `false`. */
type Refute<T extends false> = T;

export type _TypedToolIsNotAnUntypedTool = Refute<
  AssignableTo<FunctionTool<Params>, FunctionTool<undefined>>
>;

export type _UntypedToolIsNotATypedTool = Refute<
  AssignableTo<FunctionTool<undefined>, FunctionTool<Params>>
>;

export type _LongRunningToolIsNotAnUntypedTool = Refute<
  AssignableTo<LongRunningFunctionTool<Params>, FunctionTool<undefined>>
>;

export type _ToolWidensToTheParameterUnion = Assert<
  AssignableTo<FunctionTool<Params>, FunctionTool<ToolInputParameters>>
>;

export type _LongRunningToolIsAFunctionTool = Assert<
  AssignableTo<LongRunningFunctionTool<Params>, FunctionTool<Params>>
>;
