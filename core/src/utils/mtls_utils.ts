/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {execFile} from 'node:child_process';
import {readFile} from 'node:fs/promises';
import {homedir} from 'node:os';
import {join} from 'node:path';
import {promisify} from 'node:util';

import {logger} from './logger.js';

/** How `GOOGLE_API_USE_MTLS_ENDPOINT` picks between the two endpoints. */
enum MtlsEndpointSetting {
  /** Use the mutual-TLS endpoint when a client certificate is available. */
  AUTO = 'auto',
  /** Always use the mutual-TLS endpoint. */
  ALWAYS = 'always',
  /** Never use the mutual-TLS endpoint. */
  NEVER = 'never',
}

/** A client certificate and its private key, both PEM encoded. */
export interface ClientCertSource {
  /** The client certificate chain. */
  cert: string;
  /** The private key that signs the handshake. */
  key: string;
}

const USE_MTLS_ENDPOINT_ENV = 'GOOGLE_API_USE_MTLS_ENDPOINT';
const USE_CLIENT_CERTIFICATE_ENV = 'GOOGLE_API_USE_CLIENT_CERTIFICATE';

const CERT_PROVIDER_COMMAND_KEY = 'cert_provider_command';
const CERTIFICATE_PATTERN =
  /-----BEGIN CERTIFICATE-----[\s\S]+-----END CERTIFICATE-----/;
const PRIVATE_KEY_PATTERN =
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]+-----END [A-Z ]*PRIVATE KEY-----/;

/**
 * Reports whether the caller asked for a mutual-TLS client certificate.
 *
 * google-auth-library for Node exposes no equivalent of Python's
 * `mtls.should_use_client_cert()`, so `GOOGLE_API_USE_CLIENT_CERTIFICATE` is
 * the whole contract here. An unrecognised value warns and counts as `false`.
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

/** Returns the `GOOGLE_API_USE_MTLS_ENDPOINT` setting, warning if invalid. */
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
 * Returns the endpoint to call, given the mutual-TLS setting and the cert.
 *
 * @param clientCertSource The resolved client certificate, when there is one.
 * @param defaultEndpoint The endpoint to call without mutual TLS.
 * @param mtlsEndpoint The endpoint to call with mutual TLS.
 */
export function getApiEndpoint(
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
  const metadataPath = join(
    homedir(),
    '.secureConnect',
    'context_aware_metadata.json',
  );
  let contents: string;
  try {
    contents = await readFile(metadataPath, 'utf8');
  } catch (_e: unknown) {
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
 * endpoint instead of losing the connection.
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
    ({stdout} = await promisify(execFile)(file, args));
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
