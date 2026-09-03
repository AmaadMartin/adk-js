/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * An HTTP dispatcher accepted by Node's `fetch` — in practice an `undici`
 * `Agent`. Typed structurally so `undici` does not have to be a hard
 * dependency of this package.
 */
export interface HttpDispatcher {
  dispatch(...args: never[]): boolean;
}

/**
 * A dispatcher that owns a connection pool, and the credentials the pool
 * connects with, until it is closed.
 */
export interface ClosableDispatcher extends HttpDispatcher {
  close(): Promise<void>;
}

/** `fetch` options plus Node's non-standard `dispatcher`. */
// eslint-disable-next-line no-undef -- `RequestInit` is a type-only DOM global, so the `globals` package cannot declare it and `no-undef` always reports it. The repo does the same in dev/src/server/adk_api_client.ts.
export interface DispatcherRequestInit extends RequestInit {
  dispatcher?: HttpDispatcher;
}
