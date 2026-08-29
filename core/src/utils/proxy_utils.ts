/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {isIP} from 'node:net';

import {normalizeHost} from './ssrf_utils.js';

/** The environment variables a proxy can be configured with, in priority order. */
type ProxyEnv = Record<string, string | undefined>;

/**
 * Reads a proxy variable under its lowercase and uppercase spellings, both of
 * which are conventional. An empty value means "not set".
 */
function readProxyEnv(env: ProxyEnv, name: string): string | undefined {
  return env[name] || env[name.toUpperCase()] || undefined;
}

/**
 * Returns `true` when `noProxy` exempts `url` from the configured proxies.
 *
 * An entry of `*` exempts every host. Otherwise each comma-separated entry is
 * matched as a suffix of the hostname and of `hostname:port`, so `example.com`
 * and `.example.com` both cover `api.example.com`, while `example.com:8080`
 * covers only that port. An IP-literal host must match an entry exactly;
 * suffix matching would let `1.2.3.4` exempt `11.2.3.4`. CIDR entries are not
 * supported.
 */
function bypassesProxy(url: URL, noProxy: string): boolean {
  const entries = noProxy
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
  if (entries.includes('*')) {
    return true;
  }
  const hostname = normalizeHost(url.hostname);
  if (isIP(hostname) !== 0) {
    return entries.includes(hostname);
  }
  const hostWithPort = url.port ? `${hostname}:${url.port}` : hostname;
  return entries.some(
    (entry) => hostname.endsWith(entry) || hostWithPort.endsWith(entry),
  );
}

/**
 * Returns the proxy the environment names for `url`, or `undefined` for a
 * direct request.
 *
 * `no_proxy` is consulted first and wins. Otherwise the variable for the URL's
 * scheme (`https_proxy` or `http_proxy`) is preferred over `all_proxy`. This
 * is the selection `requests` performs through `get_environ_proxies` and
 * `select_proxy`, which is what the ADK Python tools follow.
 */
export function selectProxy(url: URL, env: ProxyEnv): string | undefined {
  const noProxy = readProxyEnv(env, 'no_proxy');
  if (noProxy !== undefined && bypassesProxy(url, noProxy)) {
    return undefined;
  }
  const scheme = url.protocol.slice(0, -1);
  return readProxyEnv(env, `${scheme}_proxy`) ?? readProxyEnv(env, 'all_proxy');
}
