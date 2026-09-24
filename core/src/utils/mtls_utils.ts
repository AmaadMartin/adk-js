/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/** The environment variable that asks for a client certificate. */
const USE_CLIENT_CERTIFICATE_ENV = 'GOOGLE_API_USE_CLIENT_CERTIFICATE';

/** The environment variable that selects the endpoint to call. */
const USE_MTLS_ENDPOINT_ENV = 'GOOGLE_API_USE_MTLS_ENDPOINT';

/** The host suffix every Google API endpoint carries. */
const GOOGLEAPIS_SUFFIX = '.googleapis.com';

/** The host suffix of the mutual-TLS variant of a Google API endpoint. */
const MTLS_GOOGLEAPIS_SUFFIX = '.mtls.googleapis.com';

/**
 * Reports whether the caller asked for a mutual-TLS client certificate.
 *
 * adk-python asks google-auth first and reads
 * `GOOGLE_API_USE_CLIENT_CERTIFICATE` only as a fallback. `google-auth-library`
 * for Node exposes no equivalent hook, so the variable is the whole contract
 * here. It is read on every call, so a process that changes it between calls
 * is honoured.
 */
export function useClientCertEffective(): boolean {
  return process.env[USE_CLIENT_CERTIFICATE_ENV]?.toLowerCase() === 'true';
}

/**
 * Reports whether a Google API call should go to the mutual-TLS host.
 *
 * `GOOGLE_API_USE_MTLS_ENDPOINT` decides: `always` picks the mutual-TLS host,
 * `never` picks the default one, and `auto` defers to
 * {@link useClientCertEffective}. An unset or unrecognised setting means
 * `auto`.
 */
export function shouldUseMtlsEndpoint(): boolean {
  switch (mtlsEndpointSetting()) {
    case 'always':
      return true;
    case 'never':
      return false;
    default:
      return useClientCertEffective();
  }
}

/**
 * Rewrites a `*.googleapis.com` URL to its `.mtls.googleapis.com` variant.
 *
 * `GOOGLE_API_USE_MTLS_ENDPOINT=never` opts out. A host that is not a
 * googleapis.com host, and a host that is already a mutual-TLS host, are
 * returned unchanged, so a non-Google provider is never affected.
 *
 * @param url The absolute URL the caller is about to request.
 * @return The URL to request instead.
 */
export function effectiveGoogleapisEndpoint(url: string): string {
  if (!isNonMtlsGoogleapisEndpoint(url) || mtlsEndpointSetting() === 'never') {
    return url;
  }
  const parsed = new URL(url);
  parsed.hostname =
    parsed.hostname.slice(0, -GOOGLEAPIS_SUFFIX.length) +
    MTLS_GOOGLEAPIS_SUFFIX;
  return parsed.toString();
}

/**
 * Reports whether a URL names a `*.googleapis.com` host that carries no
 * mutual-TLS infix.
 *
 * @param url The absolute URL to inspect. A string that is not a URL reads as
 *     no match.
 */
function isNonMtlsGoogleapisEndpoint(url: string): boolean {
  const host = hostnameOf(url);
  return (
    host.endsWith(GOOGLEAPIS_SUFFIX) && !host.includes(MTLS_GOOGLEAPIS_SUFFIX)
  );
}

/** Returns the host of a URL, or an empty string when it is not a URL. */
function hostnameOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
}

/** Reads `GOOGLE_API_USE_MTLS_ENDPOINT`, lowercased. Unset reads as `auto`. */
function mtlsEndpointSetting(): string {
  return (process.env[USE_MTLS_ENDPOINT_ENV] ?? '').toLowerCase();
}
