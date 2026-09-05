/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as childProcess from 'node:child_process';
import {existsSync} from 'node:fs';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {promisify} from 'node:util';
import {formatError} from './error_utils.js';
import {logger} from './logger.js';

/**
 * Chooses the API host to call, picking the mutual-TLS one when the
 * environment asks for it.
 *
 * `GOOGLE_API_USE_MTLS_ENDPOINT` selects the host: `always` picks the
 * mutual-TLS one, `never` picks the default one, and `auto` picks the
 * mutual-TLS one only when `GOOGLE_API_USE_CLIENT_CERTIFICATE` is `true` and
 * this machine has a certificate to present. Asking for a client certificate
 * is not enough on its own: the transport would present nothing, and the
 * mutual-TLS host rejects such a connection. An unset or unrecognised setting
 * means `auto`. Both variables are read case insensitively, and on every call,
 * so a process that changes one between calls is honoured.
 *
 * @param defaultEndpoint The host to call without mutual TLS.
 * @param mtlsEndpoint The mutual-TLS host.
 */
export function getApiEndpoint(
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
