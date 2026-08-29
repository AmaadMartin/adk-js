/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type {Agent} from 'undici';
import {loadOptionalPeer} from './optional_peer.js';

/**
 * An HTTP dispatcher accepted by Node's `fetch` — in practice an `undici`
 * `Agent`. Typed structurally so `undici` does not have to be a hard
 * dependency of this package.
 */
export interface HttpDispatcher {
  dispatch(...args: never[]): boolean;
}

/**
 * TLS certificate verification for a tool's outgoing requests.
 *
 * - `undefined` / `true`: verify against the system CA (the default).
 * - `false`: disable verification. Insecure; not recommended.
 * - `string`: path to a PEM CA bundle file, for a TLS-intercepting corporate
 *   proxy.
 * - `HttpDispatcher`: a dispatcher the application built itself, used
 *   verbatim.
 */
export type SslVerify = boolean | string | HttpDispatcher;

/** `fetch` options plus Node's non-standard `dispatcher`. */
// eslint-disable-next-line no-undef -- `RequestInit` is a type-only DOM global, so the `globals` package cannot declare it and `no-undef` always reports it. The repo does the same in dev/src/server/adk_api_client.ts.
export interface DispatcherRequestInit extends RequestInit {
  dispatcher?: HttpDispatcher;
}

/**
 * Maps a TLS verification setting onto the `undici` `Agent` options that
 * implement it.
 *
 * @param sslVerify `true` to verify against the system CA, `false` to disable
 *     verification, or the path to a PEM CA bundle file.
 * @return The agent options, or `undefined` when the default verification
 *     already does what was asked.
 * @throws If the CA bundle file cannot be read.
 */
export async function sslVerifyToAgentOptions(
  sslVerify: boolean | string,
): Promise<Agent.Options | undefined> {
  if (sslVerify === true) {
    return undefined;
  }
  if (sslVerify === false) {
    return {connect: {rejectUnauthorized: false}};
  }
  const {readFile} = await import('node:fs/promises');
  return {connect: {ca: await readFile(sslVerify, 'utf8')}};
}

/**
 * Builds the `fetch` dispatcher that applies a TLS verification setting.
 *
 * `undici` is an optional peer dependency, so it is loaded only when the
 * setting actually needs a custom dispatcher.
 *
 * @param sslVerify The setting, or `undefined` for default verification.
 * @return The dispatcher to attach to the request, or `undefined` to leave the
 *     request untouched.
 */
export async function resolveSslDispatcher(
  sslVerify: SslVerify | undefined,
): Promise<HttpDispatcher | undefined> {
  if (sslVerify === undefined || sslVerify === true) {
    return undefined;
  }
  if (typeof sslVerify === 'object') {
    return sslVerify;
  }
  const options = await sslVerifyToAgentOptions(sslVerify);
  const undici = await loadOptionalPeer(
    {packageName: 'undici', feature: 'sslVerify'},
    () => import('undici'),
  );
  return new undici.Agent(options);
}
