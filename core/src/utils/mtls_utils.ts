/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Mutual-TLS support for calling a Google API with a client certificate.
 *
 * adk-python delegates this to `google.auth.transport.mtls`. `google-auth-library`
 * for Node has no equivalent, so the SecureConnect device-certificate contract
 * is implemented here: read `~/.secureConnect/context_aware_metadata.json`, run
 * the `cert_provider_command` it names, and read the PEM blocks the command
 * prints.
 */

import {execFile} from 'node:child_process';
import {readFile} from 'node:fs/promises';
import * as https from 'node:https';
import {homedir} from 'node:os';
import {join} from 'node:path';
import {promisify} from 'node:util';
import {logger} from './logger.js';

const SECURE_CONNECT_DIR = '.secureConnect';
const METADATA_FILE = 'context_aware_metadata.json';

/** How long the SecureConnect certificate provider may run. */
const CERT_PROVIDER_TIMEOUT_MS = 30_000;

const CERT_PATTERN =
  /-----BEGIN CERTIFICATE-----[\s\S]+-----END CERTIFICATE-----/;
const KEY_PATTERN =
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]+-----END [A-Z ]*PRIVATE KEY-----/;
const PASSPHRASE_PATTERN =
  /-----BEGIN PASSPHRASE-----([\s\S]+)-----END PASSPHRASE-----/;

/** A client certificate and its private key, in PEM form. */
export interface MtlsClientCerts {
  /** PEM certificate, or certificate chain. */
  cert: string;
  /** PEM private key. */
  key: string;
  /** Passphrase protecting {@link key}, when the key is encrypted. */
  passphrase?: string;
}

/** The status and body of one response, decoded as text. */
export interface TextResponse {
  status: number;
  body: string;
}

/**
 * Whether the caller asked for a client certificate, via
 * `GOOGLE_API_USE_CLIENT_CERTIFICATE`.
 *
 * adk-python asks `google.auth.transport.mtls.should_use_client_cert()` first
 * and falls back to this variable. Only the variable exists in Node.
 */
export function useClientCertEffective(): boolean {
  return (
    (process.env['GOOGLE_API_USE_CLIENT_CERTIFICATE'] ?? '').toLowerCase() ===
    'true'
  );
}

/**
 * Picks the endpoint to call.
 *
 * `GOOGLE_API_USE_MTLS_ENDPOINT=always` selects `mtlsEndpoint` outright. Under
 * `auto` it is selected only when a certificate is actually available, because
 * the mTLS host rejects a connection that presents none. An unset or
 * unrecognised setting reads as `auto`.
 */
export function chooseApiEndpoint(
  clientCertSource: MtlsClientCerts | undefined,
  defaultEndpoint: string,
  mtlsEndpoint: string,
): string {
  const setting = (
    process.env['GOOGLE_API_USE_MTLS_ENDPOINT'] ?? 'auto'
  ).toLowerCase();
  if (setting === 'always') {
    return mtlsEndpoint;
  }
  if (setting === 'never') {
    return defaultEndpoint;
  }
  return clientCertSource ? mtlsEndpoint : defaultEndpoint;
}

/**
 * Reads the `cert_provider_command` out of the SecureConnect metadata file.
 */
async function readCertProviderCommand(): Promise<string[] | undefined> {
  const metadataPath = join(homedir(), SECURE_CONNECT_DIR, METADATA_FILE);
  let raw: string;
  try {
    raw = await readFile(metadataPath, 'utf8');
  } catch {
    logger.warn(
      `No SecureConnect metadata at ${metadataPath}; continuing without a client certificate.`,
    );
    return undefined;
  }

  let command: unknown;
  try {
    command = (JSON.parse(raw) as {cert_provider_command?: unknown})
      .cert_provider_command;
  } catch {
    logger.warn(
      `${metadataPath} is not valid JSON; continuing without a client certificate.`,
    );
    return undefined;
  }

  if (
    !Array.isArray(command) ||
    command.length === 0 ||
    !command.every((part): part is string => typeof part === 'string')
  ) {
    logger.warn(
      `${metadataPath} names no cert_provider_command; continuing without a client certificate.`,
    );
    return undefined;
  }
  return command;
}

/**
 * Runs the certificate provider and returns its stdout.
 *
 * The failure is reported without the command's output or the thrown error,
 * because both can carry the private key.
 *
 * `execFile` is promisified here rather than at module scope: this module is
 * reachable from the package entry point, and a test that partially mocks
 * `node:child_process` would otherwise fail to import the whole package.
 */
async function runCertProvider(command: string[]): Promise<string | undefined> {
  try {
    const {stdout} = await promisify(execFile)(command[0], command.slice(1), {
      timeout: CERT_PROVIDER_TIMEOUT_MS,
    });
    return stdout;
  } catch {
    logger.warn(
      'The SecureConnect certificate provider command failed; continuing without a client certificate.',
    );
    return undefined;
  }
}

/** Extracts the PEM blocks the certificate provider printed. */
function parseCertProviderOutput(output: string): MtlsClientCerts | undefined {
  const cert = CERT_PATTERN.exec(output)?.[0];
  const key = KEY_PATTERN.exec(output)?.[0];
  if (!cert || !key) {
    logger.warn(
      'The SecureConnect certificate provider printed no certificate and key pair; continuing without a client certificate.',
    );
    return undefined;
  }
  const passphrase = PASSPHRASE_PATTERN.exec(output)?.[1].trim();
  return passphrase ? {cert, key, passphrase} : {cert, key};
}

/**
 * The client certificate to present, or `undefined` when there is none.
 *
 * Nothing is read unless {@link useClientCertEffective} asked for a
 * certificate. After that, every failure yields `undefined` and a warning, so a
 * caller that asked for a certificate it does not have still reaches the
 * non-mTLS endpoint.
 */
export async function clientCertsToPresent(): Promise<
  MtlsClientCerts | undefined
> {
  if (!useClientCertEffective()) {
    return undefined;
  }
  const command = await readCertProviderCommand();
  if (!command) {
    return undefined;
  }
  const output = await runCertProvider(command);
  if (!output) {
    return undefined;
  }
  return parseCertProviderOutput(output);
}

/**
 * Performs one GET that presents `certs`.
 *
 * `fetch` cannot present a client certificate, so this uses `node:https`. A
 * `node:https` timeout only emits the event and leaves the socket open, so the
 * request is destroyed explicitly.
 */
export function getWithClientCert(
  url: string,
  headers: Record<string, string>,
  certs: MtlsClientCerts,
  timeoutMs: number,
): Promise<TextResponse> {
  return new Promise((resolve, reject) => {
    const request = https.request(
      url,
      {
        method: 'GET',
        headers,
        timeout: timeoutMs,
        agent: new https.Agent({
          cert: certs.cert,
          key: certs.key,
          passphrase: certs.passphrase,
        }),
      },
      (response) => {
        let body = '';
        response.setEncoding('utf8');
        response.on('data', (chunk: string) => {
          body += chunk;
        });
        response.on('end', () => {
          resolve({status: response.statusCode ?? 0, body});
        });
      },
    );
    request.on('timeout', () => {
      request.destroy(
        new Error(`Request to ${url} timed out after ${timeoutMs}ms`),
      );
    });
    request.on('error', reject);
    request.end();
  });
}
