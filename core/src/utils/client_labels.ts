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
 * Returns true for an async generator, and false for a bare async iterable: the
 * wrapper below calls `next`, `return` and `throw`, so all three must exist.
 */
function isAsyncGenerator(
  value: unknown,
): value is AsyncGenerator<unknown, unknown, unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    Symbol.asyncIterator in value &&
    typeof value[Symbol.asyncIterator] === 'function' &&
    'next' in value &&
    typeof value.next === 'function' &&
    'return' in value &&
    typeof value.return === 'function' &&
    'throw' in value &&
    typeof value.throw === 'function'
  );
}

/**
 * Wraps an async generator so that every resumption of its body runs inside the
 * client-label scope.
 *
 * A generator body does not start when the generator object is created; it
 * starts on the first `next()`, after the scope that created the object has
 * already exited. Binding each resumption is what carries the label into the
 * body.
 */
function bindClientLabelToAsyncGenerator<T, TReturn, TNext>(
  clientLabel: string,
  generator: AsyncGenerator<T, TReturn, TNext>,
): AsyncGenerator<T, TReturn, TNext> {
  return {
    next: (...args) =>
      clientLabelLocalStorage.run(clientLabel, () => generator.next(...args)),
    return: (value) =>
      clientLabelLocalStorage.run(clientLabel, () => generator.return(value)),
    throw: (error) =>
      clientLabelLocalStorage.run(clientLabel, () => generator.throw(error)),
    [Symbol.asyncIterator]() {
      return bindClientLabelToAsyncGenerator(
        clientLabel,
        generator[Symbol.asyncIterator](),
      );
    },
  };
}

/**
 * Runs the given callback within a context that has the specified client label.
 * Every LLM call the callback makes includes the client label in its tracking
 * headers.
 *
 * A callback that returns an async generator gets the label re-applied on each
 * resumption (`next`, `return` and `throw`), so a stream consumed after this
 * function returns still carries the label. For any other async iterable, or a
 * promise that resolves to one, consume the stream inside the callback.
 *
 * @param clientLabel The custom client label to apply.
 * @param callback The callback function to execute.
 * @return The result of the callback. An async generator comes back as a
 *   label-bound wrapper, which is not the object the callback returned.
 */
export function runWithClientLabel<R>(
  clientLabel: string,
  callback: () => R,
): R;
export function runWithClientLabel(
  clientLabel: string,
  callback: () => unknown,
): unknown {
  if (typeof clientLabel !== 'string' || clientLabel.trim() === '') {
    throw new Error('Client label must be a non-empty string.');
  }

  const result = clientLabelLocalStorage.run(clientLabel, callback);
  return isAsyncGenerator(result)
    ? bindClientLabelToAsyncGenerator(clientLabel, result)
    : result;
}

/**
 * Returns the current list of client labels that can be added to HTTP Headers.
 */
export function getClientLabels(): string[] {
  const labels = _getDefaultLabels();
  const contextLabel = clientLabelLocalStorage.getStore();
  if (contextLabel) {
    labels.push(contextLabel);
  }
  return labels;
}
