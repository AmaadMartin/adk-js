/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {AsyncLocalStorage} from 'node:async_hooks';
import {setClientLabelStore} from './client_labels.js';

/**
 * Installs Node's `AsyncLocalStorage` as the client-label context store.
 *
 * This module is the only place in `core/src` that names `node:async_hooks`, and
 * nothing reachable from `index_web.ts` imports it, which is what keeps the
 * browser entry point free of Node builtins.
 */
export function installNodeClientLabelStore(): void {
  setClientLabelStore(new AsyncLocalStorage<string>());
}
