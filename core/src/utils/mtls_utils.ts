/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Utilities for mutual-TLS (mTLS) endpoint resolution against Google Cloud
 * REST APIs.
 *
 * Behaviour is driven entirely by the standard Google client-library
 * environment variables:
 *
 * - `GOOGLE_API_USE_CLIENT_CERTIFICATE`: `true`/`1` to present a client
 *   certificate; anything else (including absent) disables it.
 * - `GOOGLE_API_USE_MTLS_ENDPOINT`: `auto` (default), `always` or `never`;
 *   decides whether requests target the `*.mtls.googleapis.com` host.
 * - `GOOGLE_API_CERTIFICATE_CONFIG`: path to `certificate_config.json`,
 *   overriding the well-known gcloud location.
 *
 * This module is Node-only and is deliberately not part of the browser bundle.
 */

import {readFile} from 'node:fs/promises';
import {platform} from 'node:os';
import {join} from 'node:path';
import type {Dispatcher} from 'undici';
import {getBooleanEnvVar} from './env_aware_utils.js';
import {logger} from './logger.js';

const GOOGLEAPIS_SUFFIX = '.googleapis.com';
const MTLS_GOOGLEAPIS_SUFFIX = '.mtls.googleapis.com';
const CERTIFICATE_CONFIG_FILENAME = 'certificate_config.json';

/** Values of the `GOOGLE_API_USE_MTLS_ENDPOINT` environment variable. */
export enum MtlsEndpointSetting {
  AUTO = 'auto',
  ALWAYS = 'always',
  NEVER = 'never',
}

/**
 * The subset of `certificate_config.json` this module reads. The snake_case
 * keys are the on-disk format written by gcloud and must not be camelCased.
 */
interface CertificateConfigFile {
  cert_configs?: {workload?: {cert_path?: string; key_path?: string}};
}

/**
 * The init argument accepted by the global `fetch`. Spelled as a derivation of
 * `fetch` rather than as the `RequestInit` global it resolves to, because
 * eslint's `no-undef` does not see type-only DOM globals and rejects the bare
 * name.
 */
type FetchInit = NonNullable<Parameters<typeof fetch>[1]>;

/**
 * Standard fetch init plus undici's non-standard `dispatcher` extension, which
 * is how a client certificate is attached to a request made with the global
 * `fetch`.
 */
export interface FetchInitWithDispatcher extends FetchInit {
  dispatcher?: Dispatcher;
}

/** Reads `GOOGLE_API_USE_MTLS_ENDPOINT`, defaulting to `AUTO`. */
function mtlsEndpointSetting(): MtlsEndpointSetting {
  switch ((process.env['GOOGLE_API_USE_MTLS_ENDPOINT'] ?? '').toLowerCase()) {
    case MtlsEndpointSetting.ALWAYS:
      return MtlsEndpointSetting.ALWAYS;
    case MtlsEndpointSetting.NEVER:
      return MtlsEndpointSetting.NEVER;
    default:
      return MtlsEndpointSetting.AUTO;
  }
}

/**
 * Returns the endpoint `url` should actually be called on: its
 * `*.mtls.googleapis.com` variant when the environment calls for mTLS, and
 * `url` unchanged otherwise.
 *
 * The host is rewritten only when `GOOGLE_API_USE_MTLS_ENDPOINT` is `always`,
 * or is `auto` (the default) and `hasClientCert` is true. Scheme, port, path,
 * query and fragment are preserved. Hosts that are not `*.googleapis.com`
 * hosts, and hosts that are already mTLS hosts, are returned unchanged, so
 * non-Google providers are never affected.
 *
 * Unlike adk-python's `effective_googleapis_endpoint`, this takes the
 * certificate state as an argument rather than leaving it to a separate
 * predicate, so the policy is applied in exactly one place.
 */
export function effectiveGoogleapisEndpoint(
  url: string,
  hasClientCert: boolean,
): string {
  const setting = mtlsEndpointSetting();
  const useMtls =
    setting === MtlsEndpointSetting.ALWAYS ||
    (setting === MtlsEndpointSetting.AUTO && hasClientCert);
  if (!useMtls) {
    return url;
  }
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return url;
  }
  if (
    !parsed.hostname.endsWith(GOOGLEAPIS_SUFFIX) ||
    parsed.hostname.includes(MTLS_GOOGLEAPIS_SUFFIX)
  ) {
    return url;
  }
  parsed.hostname =
    parsed.hostname.slice(0, -GOOGLEAPIS_SUFFIX.length) +
    MTLS_GOOGLEAPIS_SUFFIX;
  return parsed.toString();
}

/** Returns the gcloud configuration directory for the current platform. */
function gcloudConfigDir(): string {
  const cloudSdkConfig = process.env['CLOUDSDK_CONFIG'];
  if (cloudSdkConfig) {
    return cloudSdkConfig;
  }
  if (platform().startsWith('win')) {
    return join(process.env['APPDATA'] ?? '', 'gcloud');
  }
  return join(process.env['HOME'] ?? '', '.config', 'gcloud');
}

/**
 * Returns the path of `certificate_config.json`, preferring the
 * `GOOGLE_API_CERTIFICATE_CONFIG` override over the well-known gcloud
 * location. Mirrors the resolution order used by `google-auth-library`.
 */
function certificateConfigPath(): string {
  return (
    process.env['GOOGLE_API_CERTIFICATE_CONFIG'] ||
    join(gcloudConfigDir(), CERTIFICATE_CONFIG_FILENAME)
  );
}

/** Reads the workload client certificate described by `configPath`. */
async function readClientCertificate(
  configPath: string,
): Promise<{cert: Buffer; key: Buffer}> {
  const config = JSON.parse(
    await readFile(configPath, 'utf8'),
  ) as CertificateConfigFile;
  const workload = config.cert_configs?.workload;
  if (!workload?.cert_path || !workload.key_path) {
    throw new Error('cert_configs.workload is missing cert_path or key_path');
  }
  const [cert, key] = await Promise.all([
    readFile(workload.cert_path),
    readFile(workload.key_path),
  ]);
  return {cert, key};
}

/**
 * Builds an HTTP dispatcher that presents the application-default client
 * certificate, for use as the `dispatcher` init property of a `fetch` call.
 *
 * Returns `undefined`, without touching the filesystem, when
 * `GOOGLE_API_USE_CLIENT_CERTIFICATE` is not enabled. When a certificate is
 * requested but cannot be loaded this fails open: it logs a warning and
 * returns `undefined` so the caller falls back to a plain request rather than
 * failing outright. It never rejects, and certificate and key material is
 * never logged.
 */
export async function createMtlsDispatcher(): Promise<Dispatcher | undefined> {
  if (!getBooleanEnvVar('GOOGLE_API_USE_CLIENT_CERTIFICATE')) {
    return undefined;
  }
  const configPath = certificateConfigPath();
  try {
    const {cert, key} = await readClientCertificate(configPath);
    // Imported lazily so that the default path never pays for undici, and so
    // that this module stays importable on runtimes below undici's engine
    // floor.
    const {Agent} = await import('undici');
    return new Agent({connect: {cert, key}});
  } catch (e: unknown) {
    logger.warn(
      `Could not load the client certificate configured by ${configPath}; ` +
        `falling back to a non-mTLS request: ` +
        `${e instanceof Error ? e.message : String(e)}`,
    );
    return undefined;
  }
}
