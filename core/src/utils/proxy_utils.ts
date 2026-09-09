/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Proxy selection from the environment, following the `*_proxy` conventions
 * that `curl`, `urllib` and `requests` all implement.
 */

/** Proxy schemes this module can speak (WHATWG `URL.protocol` form). */
const PROXY_SCHEMES = new Set(['http:', 'https:']);

/**
 * Reads a proxy setting from the environment. The uppercase spelling wins when
 * both are set, and an empty value counts as unset, matching Python's
 * `urllib.request.getproxies_environment`.
 */
function proxySetting(name: string): string | undefined {
  return (
    process.env[name.toUpperCase()] || process.env[name.toLowerCase()]
  )?.trim();
}

/** Returns `true` when `no_proxy` exempts `hostname` from the proxy. */
function bypassesProxy(hostname: string, noProxy: string): boolean {
  return noProxy.split(',').some((entry) => {
    const suffix = entry.trim().toLowerCase().replace(/^\./, '');
    if (!suffix) {
      return false;
    }
    return (
      suffix === '*' || hostname === suffix || hostname.endsWith(`.${suffix}`)
    );
  });
}

/**
 * Returns the proxy the environment configures for `protocol` (`'http:'` or
 * `'https:'`) and `hostname`, or `undefined` for a direct connection.
 *
 * `hostname` carries no brackets: pass `::1`, not `[::1]`. A setting this
 * cannot speak to is treated as no proxy: `new URL` accepts the scheme-less
 * `host:port` shorthand and reads the host as a scheme, so without the scheme
 * check a typo would send the request to `localhost`.
 */
export function environmentProxyFor(
  protocol: string,
  hostname: string,
): URL | undefined {
  const noProxy = proxySetting('no_proxy');
  if (noProxy !== undefined && bypassesProxy(hostname.toLowerCase(), noProxy)) {
    return undefined;
  }
  const setting =
    proxySetting(`${protocol.replace(':', '')}_proxy`) ??
    proxySetting('all_proxy');
  if (setting === undefined) {
    return undefined;
  }
  try {
    const proxy = new URL(setting);
    return PROXY_SCHEMES.has(proxy.protocol) ? proxy : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Builds the `Proxy-Authorization` header for a proxy URL that carries
 * credentials, and an empty object for one that does not.
 */
export function proxyAuthHeaders(proxy: URL): Record<string, string> {
  if (!proxy.username) {
    return {};
  }
  const credentials = `${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}`;
  return {
    'Proxy-Authorization': `Basic ${Buffer.from(credentials).toString('base64')}`,
  };
}
