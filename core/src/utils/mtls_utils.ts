/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/** The environment variable that asks for a client certificate. */
const USE_CLIENT_CERTIFICATE_ENV = 'GOOGLE_API_USE_CLIENT_CERTIFICATE';

/** The environment variable that selects the endpoint to call. */
const USE_MTLS_ENDPOINT_ENV = 'GOOGLE_API_USE_MTLS_ENDPOINT';

/** Reads `GOOGLE_API_USE_MTLS_ENDPOINT`, lowercased. Unset reads as `auto`. */
function mtlsEndpointSetting(): string {
  return (process.env[USE_MTLS_ENDPOINT_ENV] ?? '').toLowerCase();
}

/**
 * Resolves the regional API host to call, choosing the mutual-TLS host when
 * the environment asks for it.
 *
 * `GOOGLE_API_USE_MTLS_ENDPOINT` selects the host: `always` picks the
 * mutual-TLS one, `never` picks the default one, and `auto` picks the
 * mutual-TLS one only when `GOOGLE_API_USE_CLIENT_CERTIFICATE` is `true`. An
 * unset or unrecognised setting means `auto`. Both variables are read case
 * insensitively, and on every call, so a process that changes one between
 * calls is honoured.
 *
 * @param location Region the endpoint serves, for example `us-central1`.
 * @param defaultTemplate Host template with a `{location}` placeholder.
 * @param mtlsTemplate Mutual-TLS host template with a `{location}` placeholder.
 */
export function getApiEndpoint(
  location: string,
  defaultTemplate: string,
  mtlsTemplate: string,
): string {
  const setting = mtlsEndpointSetting();
  const useMtls =
    setting === 'always' ||
    (setting !== 'never' &&
      (process.env[USE_CLIENT_CERTIFICATE_ENV] ?? '').toLowerCase() === 'true');
  return (useMtls ? mtlsTemplate : defaultTemplate).replace(
    '{location}',
    () => location,
  );
}
