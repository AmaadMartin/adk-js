/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {AsyncLocalStorage} from 'node:async_hooks';
import {version} from '../version.js';
import {isBrowser} from './env_aware_utils.js';

const ADK_LABEL = 'google-adk';
const LANGUAGE_LABEL = 'gl-typescript';
const AGENT_ENGINE_TELEMETRY_TAG = 'remote_reasoning_engine';
const AGENT_ENGINE_TELEMETRY_ENV_VARIABLE_NAME = 'GOOGLE_CLOUD_AGENT_ENGINE_ID';

const clientLabelLocalStorage = new AsyncLocalStorage<string>();

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

function _getDefaultLabels(frameworkLabel?: string): string[] {
  let frameworkToken = `${ADK_LABEL}/${version}`;

  if (frameworkLabel) {
    frameworkToken = `${frameworkToken}+${frameworkLabel}`;
  } else if (
    !isBrowser() &&
    process.env[AGENT_ENGINE_TELEMETRY_ENV_VARIABLE_NAME]
  ) {
    frameworkToken = `${frameworkToken}+${AGENT_ENGINE_TELEMETRY_TAG}`;
  }

  const languageLabelDetail = isBrowser()
    ? // eslint-disable-next-line no-undef
      parseUserAgent(window.navigator.userAgent)
    : process.version;

  const languageLabel = `${LANGUAGE_LABEL}/${languageLabelDetail}`;
  return [frameworkToken, languageLabel];
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

  return clientLabelLocalStorage.run(clientLabel, callback);
}

/**
 * Returns the current list of client labels that can be added to HTTP Headers.
 *
 * @param frameworkLabel Optional SemVer build-metadata suffix for the
 *   `google-adk` token, e.g. `managed_agent` yields
 *   `google-adk/<version>+managed_agent`. It takes precedence over the Agent
 *   Engine suffix.
 */
export function getClientLabels(frameworkLabel?: string): string[] {
  const labels = _getDefaultLabels(frameworkLabel);
  const contextLabel = clientLabelLocalStorage.getStore();
  if (contextLabel) {
    labels.push(contextLabel);
  }
  return labels;
}
