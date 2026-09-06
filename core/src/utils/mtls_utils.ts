/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as childProcess from 'node:child_process';
import {existsSync} from 'node:fs';
import * as fs from 'node:fs/promises';
import {IncomingMessage} from 'node:http';
import * as https from 'node:https';
import * as os from 'node:os';
import * as path from 'node:path';
import {promisify} from 'node:util';
import {formatError} from './error_utils.js';
import {logger} from './logger.js';
import {loadOptionalPeer} from './optional_peer.js';
import type {ClosableDispatcher} from './ssl_utils.js';

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
  const setting = readMtlsEndpointSetting();
  const useMtls =
    setting === MtlsEndpointSetting.ALWAYS ||
    (setting !== MtlsEndpointSetting.NEVER &&
      (process.env[USE_CLIENT_CERTIFICATE_ENV] ?? '').toLowerCase() === 'true');
  return (useMtls ? mtlsTemplate : defaultTemplate).replace(
    '{location}',
    () => location,
  );
}

/**
 * Chooses between two endpoints, using the certificate this machine holds.
 *
 * This is the counterpart of {@link chooseApiEndpoint} for a caller that
 * cannot await a certificate, because it picks its endpoint in a constructor.
 * Here `auto` picks the mutual-TLS endpoint only when
 * `GOOGLE_API_USE_CLIENT_CERTIFICATE` is `true` and
 * {@link hasDefaultClientCertSource} finds a certificate to present. Asking
 * for a client certificate is not enough on its own: the transport would
 * present nothing, and the mutual-TLS host rejects such a connection.
 *
 * The two endpoints are complete URLs, so nothing is substituted into them.
 *
 * @param defaultEndpoint The endpoint to call without mutual TLS.
 * @param mtlsEndpoint The endpoint to call with mutual TLS.
 */
export function chooseApiEndpointForDefaultCerts(
  defaultEndpoint: string,
  mtlsEndpoint: string,
): string {
  const setting = readMtlsEndpointSetting();
  const useMtls =
    setting === MtlsEndpointSetting.ALWAYS ||
    (setting !== MtlsEndpointSetting.NEVER &&
      useClientCertEffective() &&
      hasDefaultClientCertSource());
  return useMtls ? mtlsEndpoint : defaultEndpoint;
}

/**
 * Chooses between two endpoints, given the certificate the caller resolved.
 *
 * This is the counterpart of `getApiEndpoint` for a caller that already holds
 * its certificate. Here `auto` picks the mutual-TLS endpoint only when there
 * is a certificate to present, instead of trusting
 * `GOOGLE_API_USE_CLIENT_CERTIFICATE`. The two endpoints are complete URLs, so
 * nothing is substituted into them.
 *
 * @param clientCertSource The resolved client certificate, when there is one.
 * @param defaultEndpoint The endpoint to call without mutual TLS.
 * @param mtlsEndpoint The endpoint to call with mutual TLS.
 */
export function chooseApiEndpoint(
  clientCertSource: ClientCertSource | undefined,
  defaultEndpoint: string,
  mtlsEndpoint: string,
): string {
  const setting = readMtlsEndpointSetting();
  if (
    setting === MtlsEndpointSetting.ALWAYS ||
    (setting === MtlsEndpointSetting.AUTO && clientCertSource)
  ) {
    return mtlsEndpoint;
  }
  return defaultEndpoint;
}

/**
 * Reports whether a Google API call should go to the mutual-TLS host.
 *
 * `GOOGLE_API_USE_MTLS_ENDPOINT` decides: `always` picks the mutual-TLS host,
 * `never` picks the default one, and `auto` defers to
 * {@link useClientCertEffective}. An unset or unrecognised setting means
 * `auto`.
 *
 * This is the counterpart of `chooseApiEndpoint` for a caller that holds no
 * certificate yet, and that builds its own URL rather than picking between
 * two.
 */
export function shouldUseMtlsEndpoint(): boolean {
  switch (readMtlsEndpointSetting()) {
    case MtlsEndpointSetting.ALWAYS:
      return true;
    case MtlsEndpointSetting.NEVER:
      return false;
    default:
      return useClientCertEffective();
  }
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
  if (
    !isNonMtlsGoogleapisEndpoint(url) ||
    readMtlsEndpointSetting() === MtlsEndpointSetting.NEVER
  ) {
    return url;
  }
  const parsed = new URL(url);
  parsed.hostname =
    parsed.hostname.slice(0, -GOOGLEAPIS_SUFFIX.length) +
    MTLS_GOOGLEAPIS_SUFFIX;
  return parsed.toString();
}

/** Returns the host of a URL, or an empty string when it is not a URL. */
function hostnameOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
}

/** How `GOOGLE_API_USE_MTLS_ENDPOINT` picks between the two endpoints. */
enum MtlsEndpointSetting {
  /** Use the mutual-TLS endpoint when a client certificate is available. */
  AUTO = 'auto',
  /** Always use the mutual-TLS endpoint. */
  ALWAYS = 'always',
  /** Never use the mutual-TLS endpoint. */
  NEVER = 'never',
}

/**
 * Reads `GOOGLE_API_USE_MTLS_ENDPOINT`, lowercased.
 *
 * An unset variable reads as `auto`. An unrecognised one warns and also reads
 * as `auto`, because a typo that silently sends traffic to the wrong endpoint
 * is hard to find.
 */
function readMtlsEndpointSetting(): MtlsEndpointSetting {
  const accepted = Object.values(MtlsEndpointSetting);
  const value = (
    process.env[USE_MTLS_ENDPOINT_ENV] ?? MtlsEndpointSetting.AUTO
  ).toLowerCase();
  const setting = accepted.find((candidate) => candidate === value);
  if (setting) {
    return setting;
  }
  logger.warn(
    `Environment variable \`${USE_MTLS_ENDPOINT_ENV}\` must be one of ` +
      `${accepted.join(', ')}. Defaulting to ${MtlsEndpointSetting.AUTO}.`,
  );
  return MtlsEndpointSetting.AUTO;
}

/** A client certificate and its private key, both PEM encoded. */
export interface ClientCertSource {
  /** The client certificate chain. */
  cert: string;
  /** The private key that signs the handshake. */
  key: string;
}

/**
 * Client-certificate material for a mutual-TLS connection.
 *
 * The members are PEM text rather than file paths, so a caller can hand them
 * straight to `https.Agent` without writing a secret to disk.
 */
export interface MtlsClientCerts extends ClientCertSource {
  /** The private key, PEM encoded. It is encrypted when a passphrase is set. */
  key: string;
  /** The passphrase protecting the key, when the provider emits one. */
  passphrase?: string;
}

/** The environment variable that asks for a client certificate. */
const USE_CLIENT_CERTIFICATE_ENV = 'GOOGLE_API_USE_CLIENT_CERTIFICATE';

/** The environment variable that selects the endpoint to call. */
const USE_MTLS_ENDPOINT_ENV = 'GOOGLE_API_USE_MTLS_ENDPOINT';

/** The host suffix every Google API endpoint carries. */
const GOOGLEAPIS_SUFFIX = '.googleapis.com';

/** The host suffix of the mutual-TLS variant of a Google API endpoint. */
const MTLS_GOOGLEAPIS_SUFFIX = '.mtls.googleapis.com';

/** The flag that makes a SecureConnect provider print the key passphrase. */
const WITH_PASSPHRASE_FLAG = '--with_passphrase';

/** How long the SecureConnect certificate provider may run. */
const CERT_PROVIDER_TIMEOUT_MS = 30_000;

/** The metadata key that names the certificate provider command. */
const CERT_PROVIDER_COMMAND_KEY = 'cert_provider_command';

const CERTIFICATE_PATTERN =
  /-----BEGIN CERTIFICATE-----[\s\S]+-----END CERTIFICATE-----/;
const PRIVATE_KEY_PATTERN =
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]+-----END [A-Z ]*PRIVATE KEY-----/;
const PASSPHRASE_PATTERN =
  /-----BEGIN PASSPHRASE-----([\s\S]+)-----END PASSPHRASE-----/;

/**
 * Reports whether the caller asked for a mutual-TLS client certificate.
 *
 * adk-python asks google-auth first and reads
 * `GOOGLE_API_USE_CLIENT_CERTIFICATE` only as a fallback. `google-auth-library`
 * for Node exposes no equivalent of Python's `mtls.should_use_client_cert()`,
 * so the variable is the whole contract here. An unrecognised value warns and
 * counts as `false`.
 */
export function useClientCertEffective(): boolean {
  const value = (
    process.env[USE_CLIENT_CERTIFICATE_ENV] ?? 'false'
  ).toLowerCase();
  if (value !== 'true' && value !== 'false') {
    logger.warn(
      `Environment variable \`${USE_CLIENT_CERTIFICATE_ENV}\` must be either ` +
        '`true` or `false`',
    );
  }
  return value === 'true';
}

/**
 * Reports whether this machine has a client certificate to present.
 *
 * The answer is the existence of the context-aware metadata file that
 * {@link loadDefaultClientCerts} reads, so the two agree: a mutual-TLS host
 * chosen on the strength of this answer is one the loader can serve a
 * certificate for.
 */
export function hasDefaultClientCertSource(): boolean {
  return existsSync(defaultMetadataPath());
}

/** Returns the default SecureConnect context-aware metadata path. */
function defaultMetadataPath(): string {
  return path.join(
    os.homedir(),
    '.secureConnect',
    'context_aware_metadata.json',
  );
}

/** Reports whether a failed filesystem call means "no such file". */
function isFileNotFound(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === 'ENOENT'
  );
}

/** Returns the exit status of a failed child process, for an error message. */
function exitStatusOf(error: unknown): string {
  return typeof error === 'object' && error !== null && 'code' in error
    ? String(error.code)
    : 'an unknown error';
}

/** Reads the metadata file, or returns `undefined` when it does not exist. */
async function readMetadataFile(
  metadataPath: string,
): Promise<string | undefined> {
  try {
    return await fs.readFile(metadataPath, 'utf-8');
  } catch (error: unknown) {
    if (isFileNotFound(error)) {
      return undefined;
    }
    throw error;
  }
}

/**
 * Parses the certificate provider command out of SecureConnect metadata.
 *
 * @throws If the file is not JSON, or declares no `cert_provider_command`.
 */
function parseCertProviderCommand(
  contents: string,
  metadataPath: string,
): string[] {
  let metadata: unknown;
  try {
    metadata = JSON.parse(contents) as unknown;
  } catch {
    throw new Error(`${metadataPath} is not valid JSON.`);
  }

  const command =
    typeof metadata === 'object' &&
    metadata !== null &&
    'cert_provider_command' in metadata
      ? metadata.cert_provider_command
      : undefined;

  if (
    !Array.isArray(command) ||
    command.length === 0 ||
    !command.every((part): part is string => typeof part === 'string')
  ) {
    throw new Error(
      `${metadataPath} declares no cert_provider_command string array.`,
    );
  }
  return command;
}

/** Runs the certificate provider and returns everything it printed. */
async function runCertProvider(
  command: string[],
  metadataPath: string,
): Promise<string> {
  const [executable, ...args] = command;
  if (!args.includes(WITH_PASSPHRASE_FLAG)) {
    args.push(WITH_PASSPHRASE_FLAG);
  }

  // Bound here rather than at module load: several tests replace
  // `node:child_process` with a partial mock, and promisifying an absent
  // `execFile` throws while this module is still being evaluated.
  const execFileAsync = promisify(childProcess.execFile);

  try {
    const {stdout} = await execFileAsync(executable, args, {
      encoding: 'utf-8',
      timeout: CERT_PROVIDER_TIMEOUT_MS,
    });
    return stdout;
  } catch (error: unknown) {
    // The provider output is deliberately left out of the message: it carries
    // the certificate and the key.
    throw new Error(
      `The certificate provider named by ${metadataPath} failed with ` +
        `${exitStatusOf(error)}.`,
    );
  }
}

/**
 * Loads the SecureConnect context-aware client certificate.
 *
 * The certificate, the key and the passphrase stay in memory. adk-python writes
 * them to a temporary directory because `httplib2.add_certificate()` takes
 * paths; `https.Agent` takes PEM text, so nothing is written to disk here.
 *
 * @param options.metadataPath The context-aware metadata file to read. Defaults
 *     to `~/.secureConnect/context_aware_metadata.json`.
 * @return The certificate material, or `undefined` when the machine has no
 *     metadata file. That is the normal case and is not an error.
 * @throws If the metadata file is malformed, the provider fails, or the
 *     provider prints no certificate and key pair.
 */
export async function loadDefaultClientCerts(
  options: {metadataPath?: string} = {},
): Promise<MtlsClientCerts | undefined> {
  const metadataPath = options.metadataPath ?? defaultMetadataPath();

  const contents = await readMetadataFile(metadataPath);
  if (contents === undefined) {
    logger.debug(`No context-aware metadata at ${metadataPath}`);
    return undefined;
  }

  const output = await runCertProvider(
    parseCertProviderCommand(contents, metadataPath),
    metadataPath,
  );

  const cert = CERTIFICATE_PATTERN.exec(output)?.[0];
  const key = PRIVATE_KEY_PATTERN.exec(output)?.[0];
  if (!cert || !key) {
    throw new Error(
      `The certificate provider named by ${metadataPath} printed no ` +
        'certificate and private key pair.',
    );
  }

  const passphrase = PASSPHRASE_PATTERN.exec(output)?.[1]?.trim();
  return passphrase ? {cert, key, passphrase} : {cert, key};
}

/** Reports whether `value` is an array of strings. */
function isStringArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.every((entry: unknown) => typeof entry === 'string')
  );
}

/**
 * Returns the certificate provider command gcloud registered, if any.
 *
 * A missing metadata file is the normal case off a context-aware managed
 * device, so it is not reported. A file that exists but names no command is,
 * because the caller asked for a certificate and will not get one.
 */
async function readCertProviderCommand(): Promise<string[] | undefined> {
  // The path and the `cert_provider_command` key are the contract
  // google-auth-library-python reads in
  // `google/auth/transport/_mtls_helper.py`; this is the Node side of it.
  const metadataPath = defaultMetadataPath();
  const contents = await readMetadataFile(metadataPath).catch(() => undefined);
  if (contents === undefined) {
    return undefined;
  }

  let command: unknown;
  try {
    const metadata: unknown = JSON.parse(contents);
    if (typeof metadata === 'object' && metadata !== null) {
      command = Object.getOwnPropertyDescriptor(
        metadata,
        CERT_PROVIDER_COMMAND_KEY,
      )?.value;
    }
  } catch (e: unknown) {
    logger.warn(`Failed to parse ${metadataPath}.`, e);
    return undefined;
  }

  if (isStringArray(command) && command.length > 0) {
    return command;
  }
  logger.warn(
    `${metadataPath} does not name a \`${CERT_PROVIDER_COMMAND_KEY}\`.`,
  );
  return undefined;
}

/**
 * Returns the context-aware client certificate gcloud provides, if any.
 *
 * This is the Node stand-in for Python's
 * `google.auth.transport.mtls.default_client_cert_source()`. It never throws:
 * every failure returns `undefined` so the caller can stay on the plain
 * endpoint instead of losing the connection. `loadDefaultClientCerts` is the
 * stricter loader: it reads a passphrase too, and it reports a broken setup
 * by throwing.
 */
export async function defaultClientCertSource(): Promise<
  ClientCertSource | undefined
> {
  const command = await readCertProviderCommand();
  if (!command) {
    return undefined;
  }

  const [file, ...args] = command;
  let stdout: string;
  try {
    // `promisify` reads `execFile` here rather than at module load, so that
    // importing this module costs nothing on a process that never asks for a
    // client certificate.
    ({stdout} = await promisify(childProcess.execFile)(file, args));
  } catch (e: unknown) {
    logger.warn(`The \`${CERT_PROVIDER_COMMAND_KEY}\` \`${file}\` failed.`, e);
    return undefined;
  }

  const cert = CERTIFICATE_PATTERN.exec(stdout)?.[0];
  const key = PRIVATE_KEY_PATTERN.exec(stdout)?.[0];
  if (!cert || !key) {
    logger.warn(
      `The \`${CERT_PROVIDER_COMMAND_KEY}\` \`${file}\` printed no ` +
        'certificate and private key pair.',
    );
    return undefined;
  }
  return {cert, key};
}

/**
 * Loads the client certificate to present, when the environment asks for one.
 *
 * A machine with no certificate, and a certificate that cannot be loaded, both
 * resolve to `undefined`: the caller then connects without one, because a
 * mutual-TLS host rejects a connection that presents nothing.
 */
export async function clientCertsToPresent(): Promise<
  MtlsClientCerts | undefined
> {
  if (!useClientCertEffective()) {
    return undefined;
  }
  try {
    return await loadDefaultClientCerts();
  } catch (error: unknown) {
    logger.warn(
      'Connecting without a client certificate, because it could not be ' +
        `loaded: ${formatError(error)}`,
    );
    return undefined;
  }
}

/** The status and the body of one response, decoded as text. */
export interface TextResponse {
  status: number;
  body: string;
}

/**
 * Sends one GET that presents a client certificate.
 *
 * `globalThis.fetch` cannot present a client certificate in Node, which is why
 * this transport is `node:https`.
 *
 * @param url The absolute URL to request.
 * @param headers The request headers.
 * @param certs The certificate material to present.
 * @param timeoutMs How long the request may take before it is destroyed.
 */
export function getWithClientCert(
  url: string,
  headers: Record<string, string>,
  certs: MtlsClientCerts,
  timeoutMs: number,
): Promise<TextResponse> {
  return new Promise((resolve, reject) => {
    const collect = (response: IncomingMessage) => {
      let body = '';
      response.setEncoding('utf-8');
      response.on('data', (chunk: string) => {
        body += chunk;
      });
      response.on('error', reject);
      response.on('end', () => {
        resolve({status: response.statusCode ?? 0, body});
      });
    };

    const request = https.request(
      url,
      {headers, timeout: timeoutMs, agent: new https.Agent(certs)},
      collect,
    );
    // A timeout only fires the event; the request stays open until destroyed.
    request.on('timeout', () => {
      request.destroy(
        new Error(`Request timed out after ${timeoutMs} ms: ${url}`),
      );
    });
    request.on('error', reject);
    request.end();
  });
}

/**
 * Builds a fetch dispatcher that presents `certs` on every connection it
 * opens.
 *
 * `globalThis.fetch` has no per-request client-certificate option, so the
 * certificate has to travel on the dispatcher. This is the transport half of
 * what adk-python does with an `httpx.AsyncClient` built from
 * `cert=(cert, key, passphrase)`.
 *
 * The returned dispatcher owns the key material and the connection pool until
 * it is closed.
 *
 * @param certs The certificate material to present.
 * @return The dispatcher to attach to the request.
 * @throws If `undici` is not installed.
 */
export async function clientCertDispatcher(
  certs: MtlsClientCerts,
): Promise<ClosableDispatcher> {
  const undici = await loadOptionalPeer(
    {packageName: 'undici', feature: 'mutual-TLS client certificates'},
    () => import('undici'),
  );
  // Spreading keeps `passphrase` off the options when the provider emitted
  // none, which is what adk-python's two-tuple `cert=(cert, key)` does.
  return new undici.Agent({connect: {...certs}});
}
