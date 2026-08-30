/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {stableDigest} from '../utils/digest_utils.js';
import {AuthCredential, OAuth2Auth} from './auth_credential.js';
import {AuthScheme} from './auth_schemes.js';

/**
 * OAuth2 fields a consent round trip produces, or that change per deployment.
 * They say nothing about which credential this is, so dropping them keeps the
 * key stable across a token refresh and across a change of `redirectUri`.
 */
const VOLATILE_OAUTH2_FIELDS: readonly (keyof OAuth2Auth)[] = [
  'authUri',
  'state',
  'authResponseUri',
  'authCode',
  'accessToken',
  'refreshToken',
  'expiresAt',
  'expiresIn',
  'redirectUri',
];

/**
 * Extra fields that name a key explicitly. They are dropped before digesting,
 * so naming a key does not change the digest the name overrides.
 */
const CREDENTIAL_KEY_FIELDS: readonly string[] = [
  'credential_key',
  'credentialKey',
];

function withoutFields(
  source: object,
  fields: readonly string[],
): Record<string, unknown> {
  const copy: Record<string, unknown> = {...source};
  for (const field of fields) {
    delete copy[field];
  }
  return copy;
}

async function schemeDigestName(authScheme?: AuthScheme): Promise<string> {
  if (!authScheme) {
    return '';
  }
  const digest = await stableDigest(
    withoutFields(authScheme, CREDENTIAL_KEY_FIELDS),
  );
  return `${authScheme.type}_${digest}`;
}

async function credentialDigestName(
  authCredential?: AuthCredential,
): Promise<string> {
  if (!authCredential) {
    return '';
  }
  const digestable = withoutFields(authCredential, CREDENTIAL_KEY_FIELDS);
  if (authCredential.oauth2) {
    digestable['oauth2'] = withoutFields(
      authCredential.oauth2,
      VOLATILE_OAUTH2_FIELDS,
    );
  }
  return `${authCredential.authType}_${await stableDigest(digestable)}`;
}

/**
 * Names the credential a tool asks for, as the scheme it authenticates and the
 * credential the tool was configured with.
 *
 * A digest is used rather than a readable name because the identity is written
 * into a session state key. A readable key would carry the client secret into
 * the session store and into anything that logs a state key.
 *
 * @param authScheme The scheme the tool authenticates against.
 * @param authCredential The credential the tool was configured with.
 * @returns The identity, stable for a given scheme and credential.
 */
export async function credentialIdentity(
  authScheme?: AuthScheme,
  authCredential?: AuthCredential,
): Promise<string> {
  const schemeName = await schemeDigestName(authScheme);
  const credentialName = await credentialDigestName(authCredential);
  return `${schemeName}_${credentialName}`;
}

/**
 * Returns the default `AuthConfig.credentialKey` for a scheme and credential,
 * used when the caller names no key.
 *
 * @param authScheme The scheme the tool authenticates against.
 * @param authCredential The credential the tool was configured with.
 * @returns The derived key.
 */
export async function deriveCredentialKey(
  authScheme?: AuthScheme,
  authCredential?: AuthCredential,
): Promise<string> {
  return `adk_${await credentialIdentity(authScheme, authCredential)}`;
}

/**
 * Returns the key the caller named, or `undefined` when they named none.
 *
 * An explicit key wins over an extra field on the credential, which wins over
 * an extra field on the scheme.
 *
 * @param explicitKey The key passed by the caller.
 * @param authScheme The scheme the tool authenticates against.
 * @param authCredential The credential the tool was configured with.
 * @returns The named key, or `undefined`.
 */
export function credentialKeyOverride(
  explicitKey?: string,
  authScheme?: AuthScheme,
  authCredential?: AuthCredential,
): string | undefined {
  if (explicitKey) {
    return explicitKey;
  }
  for (const source of [authCredential, authScheme]) {
    for (const field of CREDENTIAL_KEY_FIELDS) {
      const value = (source as Record<string, unknown> | undefined)?.[field];
      if (typeof value === 'string' && value) {
        return value;
      }
    }
  }
  return undefined;
}
