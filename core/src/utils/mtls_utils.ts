/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as childProcess from 'node:child_process';
import * as fs from 'node:fs/promises';
import {IncomingMessage} from 'node:http';
import * as https from 'node:https';
import * as os from 'node:os';
import * as path from 'node:path';
import {promisify} from 'node:util';
import {formatError} from './error_utils.js';
import {logger} from './logger.js';

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
  if (!isNonMtlsGoogleapisEndpoint(url) || mtlsEndpointSetting() === 'never') {
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

/** Reads `GOOGLE_API_USE_MTLS_ENDPOINT`, lowercased. Unset reads as `auto`. */
function mtlsEndpointSetting(): string {
  return (process.env[USE_MTLS_ENDPOINT_ENV] ?? '').toLowerCase();
}

/**
 * Client-certificate material for a mutual-TLS connection.
 *
 * The members are PEM text rather than file paths, so a caller can hand them
 * straight to `https.Agent` without writing a secret to disk.
 */
export interface MtlsClientCerts {
  /** The client certificate chain, PEM encoded. */
  cert: string;
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
 * for Node exposes no equivalent hook, so the variable is the whole contract
 * here.
 */
export function useClientCertEffective(): boolean {
  return process.env[USE_CLIENT_CERTIFICATE_ENV]?.toLowerCase() === 'true';
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
