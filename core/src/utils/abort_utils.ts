/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/** A controller chained to a parent signal, with the listener's detach. */
export interface ChainedAbortController {
  /** The controller the caller aborts for its own scope. */
  controller: AbortController;
  /** Detaches the parent listener. Call it when the scope ends. */
  dispose: () => void;
}

/**
 * Creates an {@link AbortController} that also aborts when `parentSignal` does.
 *
 * A caller uses it to cancel a scope of work of its own — in-flight children,
 * one node's siblings — without losing the outer cancellation. `dispose`
 * detaches the listener so a short scope does not accumulate listeners on a
 * long-lived invocation signal.
 */
export function chainAbortController(
  parentSignal?: AbortSignal,
): ChainedAbortController {
  const controller = new AbortController();
  if (!parentSignal) {
    return {controller, dispose: () => {}};
  }
  if (parentSignal.aborted) {
    controller.abort();
    return {controller, dispose: () => {}};
  }
  const onParentAbort = () => controller.abort();
  parentSignal.addEventListener('abort', onParentAbort, {once: true});
  return {
    controller,
    dispose: () => parentSignal.removeEventListener('abort', onParentAbort),
  };
}
