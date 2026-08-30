/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {OpenAPIV3} from 'openapi-types';
import {z} from 'zod';
import {
  AuthCredential,
  AuthCredentialTypes,
  ServiceAccount,
  ServiceAccountCredential,
} from '../../../auth/auth_credential.js';
import {
  AuthScheme,
  OpenIdConnectWithConfig,
} from '../../../auth/auth_schemes.js';
import {camelCaseKeys} from '../../../utils/case_utils.js';
import {formatError} from '../../../utils/error_utils.js';

/**
 * Applies the given credential to the request headers and URL.
 *
 * @param url The target URL.
 * @param headers The request headers.
 * @param credential The auth credential.
 * @param authScheme The auth scheme from OpenAPI spec.
 * @returns The updated URL (if modified by query params).
 */
export function applyCredential(
  url: string,
  headers: Record<string, string>,
  credential?: AuthCredential,
  authScheme?: OpenAPIV3.SecuritySchemeObject,
): string {
  if (!credential) return url;

  if (credential.apiKey) {
    let inLocation: string | undefined;
    let name = 'key';

    if (authScheme && authScheme.type === 'apiKey') {
      const apiKeyScheme = authScheme as OpenAPIV3.ApiKeySecurityScheme;
      inLocation = apiKeyScheme.in;
      name = apiKeyScheme.name;
    }

    if (inLocation === 'header') {
      headers[name] = credential.apiKey;
    } else if (inLocation === 'query') {
      const separator = url.includes('?') ? '&' : '?';
      url += `${separator}${name}=${encodeURIComponent(credential.apiKey)}`;
    } else {
      // Default to header Authorization if not specified or unknown location
      headers['Authorization'] = credential.apiKey;
    }
  } else if (
    credential.http &&
    credential.http.credentials &&
    credential.http.credentials.token
  ) {
    headers['Authorization'] = `Bearer ${credential.http.credentials.token}`;
  }

  return url;
}

/**
 * Helper to create a simple API Key auth scheme.
 */
export function createApiKeyScheme(
  name: string,
  inLocation: 'header' | 'query' | 'cookie',
): OpenAPIV3.SecuritySchemeObject {
  return {
    type: 'apiKey',
    name,
    in: inLocation,
  };
}

/**
 * Helper to create a simple Bearer Token auth scheme.
 */
export function createBearerScheme(): OpenAPIV3.SecuritySchemeObject {
  return {
    type: 'http',
    scheme: 'bearer',
  };
}

/** How long to wait for an OpenID Connect discovery document. */
const OPENID_DISCOVERY_TIMEOUT_MS = 10_000;

/**
 * Token URL of the service account OAuth2 scheme.
 *
 * It is a placeholder. `ServiceAccountCredentialExchanger` exchanges the key
 * through Application Default Credentials or a JWT assertion, so nothing calls
 * this endpoint. The OAuth2 client-credentials model requires a URL.
 */
const SERVICE_ACCOUNT_TOKEN_URL = 'https://oauth2.mtls.googleapis.com/token';

/** The kind of token {@link tokenToSchemeCredential} builds a scheme for. */
export type TokenType = 'apikey' | 'oauth2Token';

/** Where an API key travels in a request. */
export type ApiKeyLocation = 'header' | 'query' | 'cookie';

/** An auth scheme and the credential that satisfies it. */
export interface SchemeCredential {
  authScheme: AuthScheme;
  /** Undefined when no credential value was supplied. */
  authCredential?: AuthCredential;
}

/** A service account scheme and the credential that satisfies it. */
export interface ServiceAccountSchemeCredential {
  authScheme: OpenAPIV3.OAuth2SecurityScheme;
  authCredential: AuthCredential;
}

/** An OpenID Connect scheme and the credential that satisfies it. */
export interface OpenIdSchemeCredential {
  authScheme: OpenIdConnectWithConfig;
  authCredential: AuthCredential;
}

const documentSchema = z.record(z.string(), z.unknown());

const serviceAccountCredentialSchema = z.object({
  type: z.literal('service_account'),
  projectId: z.string(),
  privateKeyId: z.string(),
  privateKey: z.string(),
  clientEmail: z.string(),
  clientId: z.string(),
  authUri: z.string(),
  tokenUri: z.string(),
  authProviderX509CertUrl: z.string(),
  clientX509CertUrl: z.string(),
  universeDomain: z.string(),
});

const openIdDiscoverySchema = z.object({
  authorizationEndpoint: z.string().min(1),
  tokenEndpoint: z.string().min(1),
  userinfoEndpoint: z.string().optional(),
  revocationEndpoint: z.string().optional(),
  tokenEndpointAuthMethodsSupported: z.array(z.string()).optional(),
  grantTypesSupported: z.array(z.string()).optional(),
  openIdConnectUrl: z.string().optional(),
});

const oauthClientSchema = z.object({
  clientId: z.string(),
  clientSecret: z.string(),
  redirectUri: z.string().optional(),
});

function describeIssues(error: z.ZodError): string {
  return error.issues
    .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
    .join('; ');
}

function describeFields(error: z.ZodError): string {
  return error.issues.map((issue) => issue.path.join('.')).join(', ');
}

/**
 * Builds the auth scheme of a Google service account.
 *
 * The scheme is an OAuth2 client-credentials flow rather than an HTTP bearer
 * scheme. A credential manager only exchanges a raw service account on its own
 * when the flow is client credentials. With a bearer scheme it asks the client
 * to authorize interactively instead, and the service account the tool already
 * holds goes unused.
 */
function serviceAccountAuthScheme(): OpenAPIV3.OAuth2SecurityScheme {
  return {
    type: 'oauth2',
    flows: {
      clientCredentials: {tokenUrl: SERVICE_ACCOUNT_TOKEN_URL, scopes: {}},
    },
  };
}

/**
 * Creates an auth scheme and credential for an API key or a bearer token.
 *
 * @example
 * const {authScheme, authCredential} = tokenToSchemeCredential(
 *   'apikey', 'header', 'X-API-Key', 'key_value');
 *
 * @param tokenType Whether the value is an API key or an OAuth2 token.
 * @param location Where the API key travels. Ignored for `oauth2Token`, which
 *   always travels in the `Authorization` header.
 * @param name The name of the header, query parameter or cookie.
 * @param credentialValue The API key or token. Omit it to build the scheme
 *   alone.
 * @throws Error If the token type or the API key location is invalid.
 */
export function tokenToSchemeCredential(
  tokenType: TokenType,
  location?: ApiKeyLocation,
  name?: string,
  credentialValue?: string,
): SchemeCredential {
  if (tokenType === 'apikey') {
    if (
      location !== 'header' &&
      location !== 'query' &&
      location !== 'cookie'
    ) {
      throw new Error(`Invalid location for apiKey: ${location}`);
    }
    if (!name) {
      throw new Error('Missing name for apiKey scheme');
    }
    return {
      authScheme: {type: 'apiKey', in: location, name},
      authCredential: credentialValue
        ? {authType: AuthCredentialTypes.API_KEY, apiKey: credentialValue}
        : undefined,
    };
  }

  if (tokenType === 'oauth2Token') {
    return {
      authScheme: {type: 'http', scheme: 'bearer', bearerFormat: 'JWT'},
      authCredential: credentialValue
        ? {
            authType: AuthCredentialTypes.HTTP,
            http: {scheme: 'bearer', credentials: {token: credentialValue}},
          }
        : undefined,
    };
  }

  throw new Error(`Invalid security scheme type: ${String(tokenType)}`);
}

/**
 * Creates an auth scheme and credential from a service account key file.
 *
 * @param config The parsed key file. Its keys may be snake_case, as Google
 *   writes them, or camelCase.
 * @param scopes The scopes to request when the key is exchanged.
 * @throws Error If the key file is missing a field.
 */
export function serviceAccountDictToSchemeCredential(
  config: Record<string, unknown>,
  scopes: string[],
): ServiceAccountSchemeCredential {
  const parsed = serviceAccountCredentialSchema.safeParse(
    camelCaseKeys(config),
  );
  if (!parsed.success) {
    throw new Error(
      `Invalid service account configuration: ${describeIssues(parsed.error)}`,
    );
  }
  const serviceAccountCredential: ServiceAccountCredential = parsed.data;

  return {
    authScheme: serviceAccountAuthScheme(),
    authCredential: {
      authType: AuthCredentialTypes.SERVICE_ACCOUNT,
      serviceAccount: {serviceAccountCredential, scopes},
    },
  };
}

/**
 * Creates an auth scheme and credential from a service account.
 *
 * @param config The service account to authenticate with.
 */
export function serviceAccountSchemeCredential(
  config: ServiceAccount,
): ServiceAccountSchemeCredential {
  return {
    authScheme: serviceAccountAuthScheme(),
    authCredential: {
      authType: AuthCredentialTypes.SERVICE_ACCOUNT,
      serviceAccount: config,
    },
  };
}

/**
 * Creates an OpenID Connect scheme and credential from static configuration.
 *
 * @param configDict An OpenID Connect configuration. It must hold at least
 *   `authorization_endpoint` and `token_endpoint`.
 * @param scopes The scopes to request. They override any the configuration
 *   declares.
 * @param credentialDict An OAuth client. It must hold at least `client_id` and
 *   `client_secret`, and may hold `redirect_uri`.
 * @throws Error If the configuration or the client is missing a field.
 */
export function openidDictToSchemeCredential(
  configDict: Record<string, unknown>,
  scopes: string[],
  credentialDict: Record<string, unknown>,
): OpenIdSchemeCredential {
  const parsed = openIdDiscoverySchema.safeParse(camelCaseKeys(configDict));
  if (!parsed.success) {
    throw new Error(
      `Invalid OpenID Connect configuration: ${describeIssues(parsed.error)}`,
    );
  }

  const {openIdConnectUrl, ...endpoints} = parsed.data;
  return {
    authScheme: {
      ...endpoints,
      type: 'openIdConnect',
      // A static configuration carries no discovery URL of its own.
      openIdConnectUrl: openIdConnectUrl ?? '',
      scopes,
    },
    authCredential: openIdCredential(credentialDict),
  };
}

function openIdCredential(
  credentialDict: Record<string, unknown>,
): AuthCredential {
  const credential = documentSchema.parse(camelCaseKeys(credentialDict));
  // A client secret file downloaded from the Google Cloud console nests the
  // client under a single "web" or "installed" key.
  const values = Object.values(credential);
  const source =
    values.length === 1 && oauthClientSchema.safeParse(values[0]).success
      ? values[0]
      : credential;

  const parsed = oauthClientSchema.safeParse(source);
  if (!parsed.success) {
    throw new Error(
      `Missing required fields in credentialDict: ${describeFields(parsed.error)}`,
    );
  }

  return {
    authType: AuthCredentialTypes.OPEN_ID_CONNECT,
    oauth2: {
      clientId: parsed.data.clientId,
      clientSecret: parsed.data.clientSecret,
      redirectUri: parsed.data.redirectUri,
    },
  };
}

/**
 * Creates an OpenID Connect scheme and credential from a discovery document.
 *
 * The URL is developer configuration rather than model- or user-supplied
 * input, so it is fetched as given. No host is blocked, which keeps a locally
 * hosted identity provider usable.
 *
 * @param openidUrl The OpenID Connect discovery URL.
 * @param scopes The scopes to request.
 * @param credentialDict An OAuth client. It must hold at least `client_id` and
 *   `client_secret`, and may hold `redirect_uri`.
 * @throws Error If the document cannot be fetched or read, or if the client is
 *   missing a field.
 */
export async function openidUrlToSchemeCredential(
  openidUrl: string,
  scopes: string[],
  credentialDict: Record<string, unknown>,
): Promise<OpenIdSchemeCredential> {
  const configDict = await fetchOpenIdConfiguration(openidUrl);
  configDict['openIdConnectUrl'] = openidUrl;
  return openidDictToSchemeCredential(configDict, scopes, credentialDict);
}

async function fetchOpenIdConfiguration(
  openidUrl: string,
): Promise<Record<string, unknown>> {
  let response: Response;
  try {
    response = await globalThis.fetch(openidUrl, {
      headers: {Accept: 'application/json'},
      // A discovery endpoint answers directly; a redirect would move the
      // lookup to a host the caller never named.
      redirect: 'error',
      signal: AbortSignal.timeout(OPENID_DISCOVERY_TIMEOUT_MS),
    });
  } catch (e: unknown) {
    throw new Error(
      `Failed to fetch OpenID configuration from ${openidUrl}: ${formatError(e)}`,
    );
  }

  if (!response.ok) {
    throw new Error(
      `Failed to fetch OpenID configuration from ${openidUrl}: HTTP ${response.status}`,
    );
  }

  try {
    return documentSchema.parse(await response.json());
  } catch (e: unknown) {
    throw new Error(
      `Invalid JSON response from OpenID configuration endpoint ${openidUrl}: ${formatError(e)}`,
    );
  }
}
