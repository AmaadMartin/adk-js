/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as childProcess from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {promisify} from 'node:util';
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
  const setting = (
    process.env['GOOGLE_API_USE_MTLS_ENDPOINT'] ?? ''
  ).toLowerCase();
  const useMtls =
    setting === 'always' ||
    (setting !== 'never' &&
      (process.env['GOOGLE_API_USE_CLIENT_CERTIFICATE'] ?? '').toLowerCase() ===
        'true');
  return (useMtls ? mtlsTemplate : defaultTemplate).replace(
    '{location}',
    () => location,
  );
}

const GOOGLEAPIS_SUFFIX = '.googleapis.com';
const MTLS_GOOGLEAPIS_SUFFIX = '.mtls.googleapis.com';

/** Reports whether `url` names a `*.googleapis.com` host without the mTLS infix. */
function isNonMtlsGoogleapisEndpoint(url: string): boolean {
  let hostname: string;
  try {
    hostname = new URL(url).hostname;
  } catch {
    return false;
  }
  return (
    hostname.endsWith(GOOGLEAPIS_SUFFIX) &&
    !hostname.includes(MTLS_GOOGLEAPIS_SUFFIX)
  );
}

/**
 * Rewrites a `*.googleapis.com` URL to its `*.mtls.googleapis.com` variant.
 *
 * `GOOGLE_API_USE_MTLS_ENDPOINT=never` opts out, case insensitively. A host
 * that is not a `googleapis.com` host, a host that is already a mutual-TLS
 * host, and a string that is not a URL are all returned unchanged, so a
 * non-Google provider is never affected. Scheme, port, path, query and
 * fragment are preserved.
 *
 * Call this only once a client certificate is loaded. The mutual-TLS host
 * rejects a connection that presents no certificate.
 *
 * @param url The URL the caller would otherwise request.
 * @return The URL to request.
 */
export function effectiveGoogleapisEndpoint(url: string): string {
  if (!isNonMtlsGoogleapisEndpoint(url)) {
    return url;
  }
  if (
    (process.env['GOOGLE_API_USE_MTLS_ENDPOINT'] ?? '').toLowerCase() ===
    'never'
  ) {
    return url;
  }
  const parsed = new URL(url);
  parsed.hostname =
    parsed.hostname.slice(0, -GOOGLEAPIS_SUFFIX.length) +
    MTLS_GOOGLEAPIS_SUFFIX;
  return parsed.toString();
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

  // Bound here rather than at module load. Four tests under `dev/test/cli/`
  // replace `node:child_process` with a mock that exports only `exec` and
  // `spawn`, and promisifying an absent `execFile` throws while this module is
  // still being evaluated. Hoisting this line fails cli_deploy_cloud_run_test
  // and cli_deploy_agent_engine_test with "No 'execFile' export is defined".
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
