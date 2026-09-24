/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Client-certificate discovery and mutual-TLS requests.
 *
 * Ported from adk-python `src/google/adk/utils/_mtls_utils.py`, which delegates
 * certificate discovery to `google.auth.transport.mtls`. `google-auth-library`
 * for Node has no equivalent, so the SecureConnect contract is implemented
 * here: read `~/.secureConnect/context_aware_metadata.json`, run the certificate
 * provider command it names, and read the PEM material from that command's
 * output.
 */

import {execFile} from 'node:child_process';
import {readFile} from 'node:fs/promises';
import type {IncomingMessage} from 'node:http';
import * as https from 'node:https';
import {homedir} from 'node:os';
import {join} from 'node:path';
import {logger} from './logger.js';

/** Path, relative to the home directory, of the SecureConnect metadata file. */
const CONTEXT_AWARE_METADATA_PATH = join(
  '.secureConnect',
  'context_aware_metadata.json',
);

/** Key naming the certificate provider command in the metadata file. */
const CERT_PROVIDER_COMMAND_KEY = 'cert_provider_command';

/**
 * Matches the certificate block of the provider's output. Greedy, so a chain of
 * certificates is captured as one block, matching adk-python.
 */
const CERT_PATTERN =
  /-----BEGIN CERTIFICATE-----[\s\S]+-----END CERTIFICATE-----/;

/** Matches a PKCS#1, PKCS#8, EC or encrypted private key block. */
const PRIVATE_KEY_PATTERN =
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]+-----END [A-Z ]*PRIVATE KEY-----/;

/** Matches the optional passphrase block of an encrypted private key. */
const PASSPHRASE_PATTERN =
  /-----BEGIN PASSPHRASE-----([\s\S]+)-----END PASSPHRASE-----/;

/** Value of the `GOOGLE_API_USE_MTLS_ENDPOINT` environment variable. */
export enum MtlsEndpoint {
  AUTO = 'auto',
  ALWAYS = 'always',
  NEVER = 'never',
}

/** Client-certificate material for a mutual-TLS connection, as PEM text. */
export interface MtlsClientCerts {
  /** PEM certificate, or certificate chain. */
  cert: string;
  /** PEM private key belonging to {@link MtlsClientCerts.cert}. */
  key: string;
  /** Passphrase of an encrypted private key. */
  passphrase?: string;
}

/** Status and body of a completed HTTP GET. */
export interface HttpGetResult {
  /** Whether the status is in the 2xx range. */
  ok: boolean;
  status: number;
  body: string;
}

/**
 * Returns the `GOOGLE_API_USE_MTLS_ENDPOINT` setting.
 *
 * An unset, empty or unrecognised value means {@link MtlsEndpoint.AUTO}, which
 * is how adk-python treats a value its enum rejects.
 */
export function mtlsEndpointSetting(): MtlsEndpoint {
  const setting = (
    process.env['GOOGLE_API_USE_MTLS_ENDPOINT'] ?? ''
  ).toLowerCase();
  return (
    Object.values(MtlsEndpoint).find((value) => value === setting) ??
    MtlsEndpoint.AUTO
  );
}

/**
 * Returns whether a client certificate should be presented.
 *
 * adk-python asks `google.auth.transport.mtls.should_use_client_cert()` first
 * and falls back to `GOOGLE_API_USE_CLIENT_CERTIFICATE`. `google-auth-library`
 * for Node exposes no equivalent hook, so the variable is the whole contract.
 */
export function useClientCertEffective(): boolean {
  return (
    (process.env['GOOGLE_API_USE_CLIENT_CERTIFICATE'] ?? '').toLowerCase() ===
    'true'
  );
}

/** Reads the SecureConnect metadata file, or returns undefined if unusable. */
async function readContextAwareMetadata(): Promise<
  Record<string, unknown> | undefined
> {
  const path = join(homedir(), CONTEXT_AWARE_METADATA_PATH);
  let contents: string;
  try {
    contents = await readFile(path, 'utf8');
  } catch {
    logger.debug(
      `No context-aware metadata at ${path}; no client certificate is available.`,
    );
    return undefined;
  }
  try {
    return JSON.parse(contents) as Record<string, unknown>;
  } catch {
    logger.warn(`Could not parse the context-aware metadata at ${path}.`);
    return undefined;
  }
}

/** Reads the provider command from parsed metadata, if it names a valid one. */
function certProviderCommand(
  metadata: Record<string, unknown>,
): string[] | undefined {
  const command = metadata[CERT_PROVIDER_COMMAND_KEY];
  if (
    !Array.isArray(command) ||
    command.length === 0 ||
    !command.every((part): part is string => typeof part === 'string')
  ) {
    logger.warn(
      `The context-aware metadata has no usable ${CERT_PROVIDER_COMMAND_KEY}.`,
    );
    return undefined;
  }
  return command;
}

/**
 * Extracts the PEM material from the provider's output.
 *
 * The output holds the private key, so it never reaches a log line or an error
 * message.
 */
function parseProviderOutput(output: string): MtlsClientCerts | undefined {
  const cert = CERT_PATTERN.exec(output)?.[0];
  const key = PRIVATE_KEY_PATTERN.exec(output)?.[0];
  if (!cert || !key) {
    logger.warn(
      'The client certificate provider returned no certificate and key pair.',
    );
    return undefined;
  }
  const passphrase = PASSPHRASE_PATTERN.exec(output)?.[1].trim();
  return passphrase ? {cert, key, passphrase} : {cert, key};
}

/** Runs `command` and resolves its standard output. */
function runCommand(command: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(command[0], command.slice(1), (error, stdout) => {
      if (error) {
        reject(error);
        return;
      }
      resolve(stdout);
    });
  });
}

/**
 * Loads the client certificate that SecureConnect provides on this machine.
 *
 * Returns undefined when no certificate is configured, which is the normal case
 * on a machine without context-aware access. A provider that fails is reported
 * with a warning and also yields undefined, so the caller connects without a
 * certificate rather than failing outright.
 */
export async function loadDefaultClientCerts(): Promise<
  MtlsClientCerts | undefined
> {
  const metadata = await readContextAwareMetadata();
  if (!metadata) {
    return undefined;
  }
  const command = certProviderCommand(metadata);
  if (!command) {
    return undefined;
  }
  try {
    return parseProviderOutput(await runCommand(command));
  } catch {
    // The provider's output carries the private key, so neither it nor the
    // error text it may quote is reported.
    logger.warn(
      'The client certificate provider command failed; continuing without a client certificate.',
    );
    return undefined;
  }
}

/** Reads a response body as text. */
export function collectResponseBody(
  response: IncomingMessage,
): Promise<HttpGetResult> {
  return new Promise((resolve) => {
    let body = '';
    response.setEncoding('utf8');
    response.on('data', (chunk: string) => {
      body += chunk;
    });
    response.on('end', () => {
      const status = response.statusCode ?? 0;
      resolve({ok: status >= 200 && status < 300, status, body});
    });
  });
}

/**
 * Performs an HTTPS GET that presents `certs` as the client certificate.
 *
 * `globalThis.fetch` cannot present a client certificate, which is why this
 * goes through `node:https` directly.
 */
export function getWithClientCert(
  url: string,
  headers: Record<string, string>,
  certs: MtlsClientCerts,
  timeoutMs: number,
): Promise<HttpGetResult> {
  return new Promise((resolve, reject) => {
    const request = https.request(
      url,
      {
        method: 'GET',
        headers,
        agent: new https.Agent(certs),
        timeout: timeoutMs,
      },
      (response) => {
        collectResponseBody(response).then(resolve, reject);
      },
    );
    // A node:https timeout only emits the event; the socket stays open until
    // the request is destroyed.
    request.on('timeout', () => {
      request.destroy(new Error(`Request timed out after ${timeoutMs}ms`));
    });
    request.on('error', reject);
    request.end();
  });
}
