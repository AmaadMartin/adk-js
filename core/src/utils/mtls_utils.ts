/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {existsSync, readFileSync} from 'node:fs';
import {homedir} from 'node:os';
import {join} from 'node:path';

/** The environment variable that asks for a client certificate. */
const USE_CLIENT_CERTIFICATE_ENV = 'GOOGLE_API_USE_CLIENT_CERTIFICATE';

/** The environment variable that selects the endpoint to call. */
const USE_MTLS_ENDPOINT_ENV = 'GOOGLE_API_USE_MTLS_ENDPOINT';

/** The environment variable naming a certificate configuration file. */
const CERTIFICATE_CONFIG_ENV = 'GOOGLE_API_CERTIFICATE_CONFIG';

/** The host suffix every Google API endpoint carries. */
const GOOGLEAPIS_SUFFIX = '.googleapis.com';

/** The host suffix of the mutual-TLS variant of a Google API endpoint. */
const MTLS_GOOGLEAPIS_SUFFIX = '.mtls.googleapis.com';

/** How `GOOGLE_API_USE_MTLS_ENDPOINT` selects a host. */
export enum MtlsEndpoint {
  /** Use the mutual-TLS host only when a client certificate is available. */
  AUTO = 'auto',
  /** Always use the mutual-TLS host. */
  ALWAYS = 'always',
  /** Never use the mutual-TLS host. */
  NEVER = 'never',
}

/**
 * Reads `GOOGLE_API_USE_MTLS_ENDPOINT`. Unset or unrecognised reads as
 * {@link MtlsEndpoint.AUTO}.
 */
export function mtlsEndpointSetting(): MtlsEndpoint {
  switch ((process.env[USE_MTLS_ENDPOINT_ENV] ?? '').toLowerCase()) {
    case MtlsEndpoint.ALWAYS:
      return MtlsEndpoint.ALWAYS;
    case MtlsEndpoint.NEVER:
      return MtlsEndpoint.NEVER;
    default:
      return MtlsEndpoint.AUTO;
  }
}

/**
 * Reports whether this machine carries a default client certificate source.
 *
 * The three locations are the ones google-auth reads: the context-aware
 * metadata the Endpoint Verification agent writes, the gcloud certificate
 * configuration, and a configuration named by `GOOGLE_API_CERTIFICATE_CONFIG`.
 */
export function hasDefaultClientCertSource(): boolean {
  const candidates = [
    join(homedir(), '.secureConnect', 'context_aware_metadata.json'),
    join(homedir(), '.config', 'gcloud', 'certificate_config.json'),
    process.env[CERTIFICATE_CONFIG_ENV],
  ];
  return candidates.some((path) => !!path && existsSync(path));
}

/**
 * Reports whether the caller asked for a mutual-TLS client certificate.
 *
 * `GOOGLE_API_USE_CLIENT_CERTIFICATE` decides when it is set: only `true` asks
 * for a certificate, and any other value declines one. When it is unset or
 * empty, the certificate configuration named by `GOOGLE_API_CERTIFICATE_CONFIG`
 * decides, and asks for a certificate when the file declares a workload one.
 *
 * The environment is read on every call, so a process that changes it between
 * calls is honoured.
 */
export function useClientCertEffective(): boolean {
  const useClientCert = process.env[USE_CLIENT_CERTIFICATE_ENV];
  if (useClientCert) {
    return useClientCert.toLowerCase() === 'true';
  }
  const certConfigPath = process.env[CERTIFICATE_CONFIG_ENV];
  return !!certConfigPath && declaresWorkloadCert(certConfigPath);
}

/**
 * Reports whether a Google API call should go to the mutual-TLS host.
 *
 * `GOOGLE_API_USE_MTLS_ENDPOINT` decides: `always` picks the mutual-TLS host,
 * `never` picks the default one, and `auto` picks the mutual-TLS host only
 * when a client certificate is available. Asking for a certificate is not
 * enough on its own, because the mutual-TLS host rejects a connection that
 * presents none.
 *
 * @param clientCertAvailable Whether a client certificate is available, which
 *     is {@link useClientCertEffective} and {@link hasDefaultClientCertSource}
 *     together.
 */
export function shouldUseMtlsEndpoint(clientCertAvailable: boolean): boolean {
  switch (mtlsEndpointSetting()) {
    case MtlsEndpoint.ALWAYS:
      return true;
    case MtlsEndpoint.NEVER:
      return false;
    default:
      return clientCertAvailable;
  }
}

/**
 * Reports whether a URL names a `*.googleapis.com` host that carries no
 * mutual-TLS infix.
 *
 * @param url The absolute URL to inspect. A string that is not a URL reads as
 *     no match.
 */
export function isNonMtlsGoogleapisEndpoint(url: string): boolean {
  const host = hostnameOf(url);
  return (
    host.endsWith(GOOGLEAPIS_SUFFIX) && !host.includes(MTLS_GOOGLEAPIS_SUFFIX)
  );
}

/**
 * Rewrites a `*.googleapis.com` URL to its `.mtls.googleapis.com` variant.
 *
 * A host that is not a googleapis.com host, and a host that is already a
 * mutual-TLS host, are returned unchanged, so a non-Google provider is never
 * affected. Whether to rewrite at all is {@link shouldUseMtlsEndpoint}.
 *
 * @param url The absolute URL the caller is about to request.
 * @return The URL to request instead.
 */
export function effectiveGoogleapisEndpoint(url: string): string {
  if (!isNonMtlsGoogleapisEndpoint(url)) {
    return url;
  }
  const parsed = new URL(url);
  parsed.hostname =
    parsed.hostname.slice(0, -GOOGLEAPIS_SUFFIX.length) +
    MTLS_GOOGLEAPIS_SUFFIX;
  const rewritten = parsed.toString();
  // `URL` supplies a root path the caller omitted; leave it omitted.
  return !url.endsWith('/') && rewritten.endsWith('/')
    ? rewritten.slice(0, -1)
    : rewritten;
}

/** Returns the host of a URL, or an empty string when it is not a URL. */
function hostnameOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
}

/**
 * Reports whether a certificate configuration file declares a workload
 * certificate. A file that is missing, unreadable or malformed declares none.
 */
function declaresWorkloadCert(path: string): boolean {
  try {
    return hasWorkloadKey(JSON.parse(readFileSync(path, 'utf8')));
  } catch {
    return false;
  }
}

/** Reports whether a parsed configuration carries `cert_configs.workload`. */
function hasWorkloadKey(config: unknown): boolean {
  if (typeof config !== 'object' || config === null) {
    return false;
  }
  if (!('cert_configs' in config)) {
    return false;
  }
  const certConfigs = config.cert_configs;
  return (
    typeof certConfigs === 'object' &&
    certConfigs !== null &&
    'workload' in certConfigs
  );
}
