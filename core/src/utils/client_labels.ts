/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {version} from '../version.js';
import {AsyncLocalStorage as SingleSlotClientLabelStore} from './async_hooks_shim.js';
import {isBrowser} from './env_aware_utils.js';

const ADK_LABEL = 'google-adk';
const LANGUAGE_LABEL = 'gl-typescript';
const AGENT_ENGINE_TELEMETRY_TAG = 'remote_reasoning_engine';
const AGENT_ENGINE_TELEMETRY_ENV_VARIABLE_NAME = 'GOOGLE_CLOUD_AGENT_ENGINE_ID';

/**
 * The slice of `AsyncLocalStorage` that client-label propagation needs.
 *
 * Node installs a real `AsyncLocalStorage` (see `client_labels_node.ts`); other
 * runtimes fall back to the synchronous single-slot store in
 * `async_hooks_shim.ts`.
 */
export interface ClientLabelStore {
  run<R>(clientLabel: string, callback: () => R): R;
  getStore(): string | undefined;
}

let clientLabelStore: ClientLabelStore =
  new SingleSlotClientLabelStore<string>();

/**
 * Installs the context store backing `runWithClientLabel`. Node calls this from
 * `index.ts` to swap in a real `AsyncLocalStorage`; every other runtime keeps
 * the synchronous fallback. Internal — not part of the public API.
 */
export function setClientLabelStore(store: ClientLabelStore): void {
  clientLabelStore = store;
}

const USER_AGENT_PATTERNS = [
  ['Edge', /(?:Edg|Edge|EdgA)\/([0-9.]+)/i],
  ['Firefox', /(?:Firefox|FxiOS)\/([0-9.]+)/i],
  ['Chrome', /(?:Chrome|CriOS)\/([0-9.]+)/i],
  ['Safari', /Version\/([0-9.]+).*Safari/i],
] as const;

export function parseUserAgent(userAgent: string): string {
  if (!userAgent) {
    return 'Browser';
  }

  for (const [name, regex] of USER_AGENT_PATTERNS) {
    const match = userAgent.match(regex);
    if (match) {
      return `${name}/${match[1]}`;
    }
  }

  return 'Browser';
}

function _getDefaultLabels(): string[] {
  let frameworkLabel = `${ADK_LABEL}/${version}`;

  if (!isBrowser() && process.env[AGENT_ENGINE_TELEMETRY_ENV_VARIABLE_NAME]) {
    frameworkLabel = `${frameworkLabel}+${AGENT_ENGINE_TELEMETRY_TAG}`;
  }

  const languageLabelDetail = isBrowser()
    ? // eslint-disable-next-line no-undef
      parseUserAgent(window.navigator.userAgent)
    : process.version;

  const languageLabel = `${LANGUAGE_LABEL}/${languageLabelDetail}`;
  return [frameworkLabel, languageLabel];
}

/**
 * Runs the given callback within a context that has the specified client label.
 * All LLM calls made within this callback will include the client label in their tracking headers.
 *
 * @param clientLabel The custom client label to apply.
 * @param callback The callback function to execute.
 * @return The result of the callback.
 */
export function runWithClientLabel<R>(
  clientLabel: string,
  callback: () => R,
): R {
  if (typeof clientLabel !== 'string' || clientLabel.trim() === '') {
    throw new Error('Client label must be a non-empty string.');
  }

  return clientLabelStore.run(clientLabel, callback);
}

/**
 * Returns the current list of client labels that can be added to HTTP Headers.
 */
export function getClientLabels(): string[] {
  const labels = _getDefaultLabels();
  const contextLabel = clientLabelStore.getStore();
  if (contextLabel) {
    labels.push(contextLabel);
  }
  return labels;
}
