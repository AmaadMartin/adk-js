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
 * Certificate loading is Node-only, so every Node built-in is imported lazily
 * from behind the `GOOGLE_API_USE_CLIENT_CERTIFICATE` gate. That keeps this
 * module importable from `oauth2_utils.ts`, which the browser bundle re-exports
 * through `common.ts`.
 */

import type {Dispatcher} from 'undici';
import {getBooleanEnvVar} from './env_aware_utils.js';
import {logger} from './logger.js';

const GOOGLEAPIS_SUFFIX = '.googleapis.com';
const MTLS_GOOGLEAPIS_SUFFIX = '.mtls.googleapis.com';
const CERTIFICATE_CONFIG_FILENAME = 'certificate_config.json';
const SECURE_CONNECT_DIRNAME = '.secureConnect';
const SECURE_CONNECT_METADATA_FILENAME = 'context_aware_metadata.json';

/** How long `cert_provider_command` may run before it is killed. */
const CERT_PROVIDER_TIMEOUT_MS = 10_000;

/** Cap on the output `cert_provider_command` may write; a certificate chain
 * plus a key is a few kilobytes. */
const MAX_CERT_PROVIDER_OUTPUT_BYTES = 1024 * 1024;

/** The PEM blocks `cert_provider_command` writes, as `google-auth` matches them. */
const CERT_BLOCK_PATTERN =
  /-----BEGIN CERTIFICATE-----[\s\S]+-----END CERTIFICATE-----\r?\n?/;
const KEY_BLOCK_PATTERN =
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]+-----END [A-Z ]*PRIVATE KEY-----\r?\n?/;
const PASSPHRASE_BLOCK_HEADER = '-----BEGIN PASSPHRASE-----';

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
 * The subset of `context_aware_metadata.json` this module reads. The
 * snake_case key is the on-disk format written by Secure Connect.
 */
interface ContextAwareMetadata {
  cert_provider_command?: string[];
}

/** A PEM-encoded client certificate and its unencrypted private key. */
interface ClientCertificate {
  cert: string | Buffer;
  key: string | Buffer;
}

/** Returns the message of a value thrown from an unknown source. */
function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
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

/**
 * Reads `GOOGLE_API_USE_MTLS_ENDPOINT`, defaulting to `AUTO`. `oauth2_utils.ts`
 * calls this from the browser bundle, where there is no environment, so the
 * read is guarded the way `getBooleanEnvVar` guards its own.
 */
function mtlsEndpointSetting(): MtlsEndpointSetting {
  if (!process.env) {
    return MtlsEndpointSetting.AUTO;
  }
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
async function gcloudConfigDir(): Promise<string> {
  const cloudSdkConfig = process.env['CLOUDSDK_CONFIG'];
  if (cloudSdkConfig) {
    return cloudSdkConfig;
  }
  const {platform} = await import('node:os');
  const {join} = await import('node:path');
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
async function certificateConfigPath(): Promise<string> {
  const override = process.env['GOOGLE_API_CERTIFICATE_CONFIG'];
  if (override) {
    return override;
  }
  const {join} = await import('node:path');
  return join(await gcloudConfigDir(), CERTIFICATE_CONFIG_FILENAME);
}

/** Reads and parses a JSON file, naming it in any failure. */
async function readJsonFile<T>(path: string): Promise<T> {
  const {readFile} = await import('node:fs/promises');
  try {
    return JSON.parse(await readFile(path, 'utf8')) as T;
  } catch (e: unknown) {
    throw new Error(`${path}: ${errorMessage(e)}`);
  }
}

/** Reads the workload client certificate named by `certificate_config.json`. */
async function readWorkloadCertificate(): Promise<ClientCertificate> {
  const configPath = await certificateConfigPath();
  const config = await readJsonFile<CertificateConfigFile>(configPath);
  const workload = config.cert_configs?.workload;
  if (!workload?.cert_path || !workload.key_path) {
    throw new Error(
      `${configPath}: cert_configs.workload is missing cert_path or key_path`,
    );
  }
  const {readFile} = await import('node:fs/promises');
  const [cert, key] = await Promise.all([
    readFile(workload.cert_path),
    readFile(workload.key_path),
  ]);
  return {cert, key};
}

/**
 * Reads the client certificate from the Secure Connect provider command named
 * by `~/.secureConnect/context_aware_metadata.json`.
 *
 * Running that command is the documented Secure Connect mechanism and carries
 * the trust model gcloud uses: the operator both sets
 * `GOOGLE_API_USE_CLIENT_CERTIFICATE` and writes the command into a file in
 * their own home directory.
 */
async function readSecureConnectCertificate(): Promise<ClientCertificate> {
  const {homedir} = await import('node:os');
  const {join} = await import('node:path');
  const metadataPath = join(
    homedir(),
    SECURE_CONNECT_DIRNAME,
    SECURE_CONNECT_METADATA_FILENAME,
  );
  const metadata = await readJsonFile<ContextAwareMetadata>(metadataPath);
  const argv = metadata.cert_provider_command;
  if (!argv?.length) {
    throw new Error(`${metadataPath}: no cert_provider_command`);
  }
  return parseClientCertificate(await runCertProviderCommand(argv));
}

/**
 * Extracts the certificate chain and its private key from the standard output
 * of a `cert_provider_command`. Both patterns are greedy, matching
 * `google-auth`'s, so a chain of certificates is one block. Only an
 * unencrypted key can be presented, so a protected key is rejected here rather
 * than failing later inside the TLS stack.
 */
function parseClientCertificate(stdout: string): ClientCertificate {
  const cert = CERT_BLOCK_PATTERN.exec(stdout)?.[0];
  const key = KEY_BLOCK_PATTERN.exec(stdout)?.[0];
  if (!cert || !key) {
    throw new Error(
      'cert_provider_command wrote no certificate block or no private key block',
    );
  }
  if (key.includes('ENCRYPTED') || stdout.includes(PASSPHRASE_BLOCK_HEADER)) {
    throw new Error('cert_provider_command wrote an encrypted private key');
  }
  return {cert, key};
}

/** Runs the operator's `cert_provider_command` and returns its standard output. */
async function runCertProviderCommand(argv: string[]): Promise<string> {
  const {spawn} = await import('node:child_process');
  return new Promise<string>((resolve, reject) => {
    // No shell: the argv comes from a config file and must not be re-parsed.
    const child = spawn(argv[0], argv.slice(1), {shell: false});
    let stdout = '';
    const fail = (message: string) => {
      clearTimeout(timer);
      child.kill();
      reject(new Error(message));
    };
    const timer = setTimeout(
      () =>
        fail(
          `cert_provider_command timed out after ${CERT_PROVIDER_TIMEOUT_MS}ms`,
        ),
      CERT_PROVIDER_TIMEOUT_MS,
    );
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
      if (stdout.length > MAX_CERT_PROVIDER_OUTPUT_BYTES) {
        fail(
          `cert_provider_command wrote more than ${MAX_CERT_PROVIDER_OUTPUT_BYTES} bytes`,
        );
      }
    });
    child.on('error', (e: Error) => fail(errorMessage(e)));
    child.on('close', (code: number | null) => {
      clearTimeout(timer);
      if (code === 0) {
        resolve(stdout);
      } else {
        reject(new Error(`cert_provider_command exited with code ${code}`));
      }
    });
  });
}

/** The certificate sources, in the order `google-auth` consults them. */
const CERTIFICATE_SOURCES = [
  readWorkloadCertificate,
  readSecureConnectCertificate,
];

/**
 * Loads the client certificate from the first source that supplies one.
 * Throws with every source's failure when none does, so an operator who
 * enabled mTLS sees why no certificate was found.
 */
async function loadClientCertificate(): Promise<ClientCertificate> {
  const failures: string[] = [];
  for (const source of CERTIFICATE_SOURCES) {
    try {
      return await source();
    } catch (e: unknown) {
      failures.push(errorMessage(e));
    }
  }
  throw new Error(failures.join('; '));
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
  try {
    const {cert, key} = await loadClientCertificate();
    // Imported lazily so that the default path never pays for undici, and so
    // that this module stays importable on runtimes below undici's engine
    // floor.
    const {Agent} = await import('undici');
    return new Agent({connect: {cert, key}});
  } catch (e: unknown) {
    logger.warn(
      `Could not load a client certificate; falling back to a non-mTLS ` +
        `request: ${errorMessage(e)}`,
    );
    return undefined;
  }
}

/** An mTLS endpoint and the dispatcher that presents a certificate to it. */
export interface MtlsRequest {
  url: string;
  dispatcher: Dispatcher;
}

/**
 * Resolves the mTLS form of `url`, or `undefined` to leave the request exactly
 * as it is today.
 *
 * The certificate is presented only to a host this rewrote, so a non-Google
 * endpoint, an endpoint that is already an mTLS host, and the
 * `GOOGLE_API_USE_MTLS_ENDPOINT=never` opt-out all keep the plain request. The
 * endpoint is likewise rewritten only once a certificate is in hand, because
 * the mTLS host rejects a connection that presents none. Nothing is read from
 * the filesystem unless `url` is a rewritable endpoint.
 *
 * This suits a caller that must not degrade, such as a credential exchange.
 * `createMtlsDispatcher` and `effectiveGoogleapisEndpoint` remain available to
 * a caller that wants the two decisions separately.
 */
export async function resolveMtlsRequest(
  url: string,
): Promise<MtlsRequest | undefined> {
  // Asks what the endpoint would become given a certificate, before paying to
  // load one.
  const mtlsUrl = effectiveGoogleapisEndpoint(url, true);
  if (mtlsUrl === url) {
    return undefined;
  }
  const dispatcher = await createMtlsDispatcher();
  return dispatcher ? {url: mtlsUrl, dispatcher} : undefined;
}
