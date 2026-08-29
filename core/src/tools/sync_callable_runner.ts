/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {AsyncLocalStorage} from 'node:async_hooks';

/**
 * Runs a synchronous tool body somewhere other than the caller's event loop.
 *
 * The runner receives a thunk over the already-validated arguments, not the
 * target plus its arguments the way adk-python does. A JavaScript function is
 * not structured-cloneable, so a host cannot do anything with the target that
 * it cannot do with the thunk, and the thunk needs no cast to stay typed.
 */
export type SyncCallableRunner = (call: () => unknown) => Promise<unknown>;

const syncCallableRunnerStorage = new AsyncLocalStorage<
  SyncCallableRunner | undefined
>();

/**
 * Binds the runner that {@link FunctionTool} uses for a synchronous `execute`,
 * for the duration of `callback`.
 *
 * A host binds a runner to keep a blocking tool body off the event loop while
 * argument validation, authentication and confirmation stay on it. Pass
 * `undefined` to clear the binding, so that a tool call made from inside an
 * offloaded body runs inline instead of offloading again.
 *
 * @param runner The runner to bind, or `undefined` to clear the binding.
 * @param callback The function to run with that binding.
 * @return The result of `callback`.
 */
export function runWithSyncCallableRunner<R>(
  runner: SyncCallableRunner | undefined,
  callback: () => R,
): R {
  return syncCallableRunnerStorage.run(runner, callback);
}

/** Returns the runner bound around the current call, if there is one. */
export function getSyncCallableRunner(): SyncCallableRunner | undefined {
  return syncCallableRunnerStorage.getStore();
}

const ASYNC_FUNCTION_TAGS = new Set([
  '[object AsyncFunction]',
  '[object AsyncGeneratorFunction]',
]);

/**
 * Whether `fn` is declared `async`, read from its `Symbol.toStringTag`.
 *
 * An ordinary function that returns a promise is tagged `[object Function]`, so
 * it is treated as synchronous and goes through the runner. The result still
 * resolves correctly, because the runner awaits the thunk.
 */
export function isAsyncCallable(fn: (...args: never[]) => unknown): boolean {
  return ASYNC_FUNCTION_TAGS.has(Object.prototype.toString.call(fn));
}
