/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Type-level conformance checks for the *published* type surface of
 * `@google/adk`.
 *
 * This file is deliberately typechecked against `core/dist/types` (the
 * declarations that ship to npm), not against `core/src`. TypeScript erases
 * the declared type of `private` class members during declaration emit, so a
 * generic that is only referenced by private members disappears from the
 * shipped `.d.ts` and stops constraining consumers. These assertions pin the
 * published behaviour so that divergence fails the build instead of shipping.
 */

import {
  FunctionTool,
  LongRunningFunctionTool,
  ToolInputParameters,
} from '@google/adk';
import {z} from 'zod';

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
