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
} from '../../../auth/auth_credential.js';
import {
  AuthScheme,
  OpenIdConnectWithConfig,
} from '../../../auth/auth_schemes.js';
import {validateDiscoveryUrl} from '../../../auth/oauth2/oauth2_discovery.js';
import {camelCaseRecordKeys} from '../../../utils/case_utils.js';
import {formatError} from '../../../utils/error_utils.js';
import type {ApiParameter} from '../openapi_spec_parser/operation_parser.js';

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

/** A service account scheme paired with the credential that satisfies it. */
export interface ServiceAccountSchemeCredential {
  authScheme: OpenAPIV3.OAuth2SecurityScheme;
  authCredential: AuthCredential;
}

/**
 * Placeholder token URL for the service account client-credentials scheme.
 *
 * The service account exchange obtains its own token from Application Default
 * Credentials or a JWT assertion, so it never calls this endpoint. The OAuth2
 * client-credentials model requires a token URL, and the mTLS host form is the
 * one Google API endpoints expect.
 */
const SERVICE_ACCOUNT_TOKEN_URL = 'https://oauth2.mtls.googleapis.com/token';

/**
 * Builds the auth scheme and auth credential for a Google service account.
 *
 * The scheme is an OAuth2 client-credentials flow, matching adk-python's
 * `_service_account_auth_scheme`. That shape marks the credential
 * non-interactive: a credential manager that keys off the flow only
 * auto-exchanges a raw service account when the scheme is OAuth2 or OIDC
 * client-credentials. An HTTP bearer scheme reads as interactive, so the tool
 * asks the client to authorize instead of exchanging the service account it
 * already holds. After exchange the credential is an HTTP bearer token.
 *
 * @param config The service account configuration to exchange at call time.
 * @returns The auth scheme and the auth credential to configure a tool with.
 */
export function serviceAccountSchemeCredential(
  config: ServiceAccount,
): ServiceAccountSchemeCredential {
  return {
    authScheme: {
      type: 'oauth2',
      flows: {
        clientCredentials: {tokenUrl: SERVICE_ACCOUNT_TOKEN_URL, scopes: {}},
      },
    },
    authCredential: {
      authType: AuthCredentialTypes.SERVICE_ACCOUNT,
      serviceAccount: config,
    },
  };
}

/** How long to wait for an OpenID Connect discovery document. */
const OPENID_DISCOVERY_TIMEOUT_MS = 10_000;

/** Prefix that marks a tool argument as an injected auth value. */
export const INTERNAL_AUTH_PREFIX = '_auth_prefix_vaf_';

/** Shorthand token kinds accepted by {@link tokenToSchemeCredential}. */
type TokenType = 'apikey' | 'oauth2Token';

/** Where an API key travels. */
type ApiKeyLocation = 'header' | 'query' | 'cookie';

/** A scheme paired with the credential that satisfies it. */
export interface SchemeCredential {
  authScheme: OpenAPIV3.SecuritySchemeObject;
  /** Absent when no credential value was supplied. */
  authCredential?: AuthCredential;
}

/** An OpenID Connect scheme paired with its client credential. */
export interface OpenIdSchemeCredential {
  authScheme: OpenIdConnectWithConfig;
  authCredential: AuthCredential;
}

/** A generated auth parameter and the argument value that fills it. */
export interface CredentialParam {
  param: ApiParameter;
  kwargs: Record<string, string>;
}

/** The discovery document fields carried onto an OpenID Connect scheme. */
const openIdDiscoverySchema = z.object({
  authorizationEndpoint: z.string().min(1),
  tokenEndpoint: z.string().min(1),
  userinfoEndpoint: z.string().optional(),
  revocationEndpoint: z.string().optional(),
  tokenEndpointAuthMethodsSupported: z.array(z.string()).optional(),
  grantTypesSupported: z.array(z.string()).optional(),
  openIdConnectUrl: z.string().default(''),
});

/** The OAuth client fields an OpenID Connect credential needs. */
const openIdClientSchema = z.object({
  clientId: z.string(),
  clientSecret: z.string(),
  redirectUri: z.string().optional(),
});

/** Renders zod issues as `field: message` pairs. */
function describeIssues(error: z.ZodError): string {
  return error.issues
    .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
    .join('; ');
}

/** Narrows an arbitrary value to a plain JSON object. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isTokenType(value: string): value is TokenType {
  return value === 'apikey' || value === 'oauth2Token';
}

function isApiKeyLocation(value: string | undefined): value is ApiKeyLocation {
  return value === 'header' || value === 'query' || value === 'cookie';
}

/**
 * Creates an auth scheme and auth credential for an API key or a bearer token.
 *
 * `location` and `name` are ignored for `oauth2Token`, because a bearer token
 * always rides the `Authorization` header.
 *
 * @param tokenType Either `apikey` or `oauth2Token`.
 * @param location Where an API key travels: `header`, `query` or `cookie`.
 * @param name The header, query parameter or cookie name for an API key.
 * @param credentialValue The API key or token value. Omit it to get the scheme
 *   without a credential.
 * @returns The auth scheme, and the auth credential when a value was supplied.
 * @throws Error If the token type or the API key location is not supported.
 */
export function tokenToSchemeCredential(
  tokenType: string,
  location?: string,
  name?: string,
  credentialValue?: string,
): SchemeCredential {
  if (!isTokenType(tokenType)) {
    throw new Error(`Invalid security scheme type: ${tokenType}`);
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

  if (!isApiKeyLocation(location)) {
    throw new Error(`Invalid location for apiKey: ${location}`);
  }

  return {
    authScheme: {type: 'apiKey', in: location, name: name ?? ''},
    authCredential: credentialValue
      ? {authType: AuthCredentialTypes.API_KEY, apiKey: credentialValue}
      : undefined,
  };
}

/**
 * The fields a service account credential declares. Unknown keys pass through, so
 * a key file written by a newer release still reaches the exchanger.
 */
const serviceAccountCredentialSchema = z
  .object({
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
  })
  .loose();

/**
 * Builds the auth scheme and auth credential from a downloaded service account
 * key file.
 *
 * @param config A service account key, with the snake_case keys Google issues.
 * @param scopes The scopes to request at exchange time.
 * @returns The auth scheme and the auth credential to configure a tool with.
 * @throws Error If the key is missing a field the token exchange needs.
 */
export function serviceAccountDictToSchemeCredential(
  config: Record<string, unknown>,
  scopes: string[],
): ServiceAccountSchemeCredential {
  const credential = serviceAccountCredentialSchema.safeParse(
    camelCaseRecordKeys(config),
  );
  if (!credential.success) {
    throw new Error(
      `Invalid service account key: ${describeIssues(credential.error)}`,
    );
  }
  return serviceAccountSchemeCredential({
    serviceAccountCredential: credential.data,
    scopes,
  });
}

/**
 * Builds an OpenID Connect scheme and credential from a discovery document and
 * an OAuth client, both already in memory.
 *
 * A client downloaded from the Google Cloud console nests its fields under a
 * single key, such as `web`. That wrapper is unwrapped here.
 *
 * @param configDict An OpenID Connect discovery document. It must carry
 *   `authorization_endpoint` and `token_endpoint`.
 * @param scopes The scopes to request.
 * @param credentialDict An OAuth client. It must carry `client_id` and
 *   `client_secret`, and may carry `redirect_uri`.
 * @returns The OpenID Connect scheme and its client credential.
 * @throws Error If the document or the client is missing a required field.
 */
export function openIdDictToSchemeCredential(
  configDict: Record<string, unknown>,
  scopes: string[],
  credentialDict: Record<string, unknown>,
): OpenIdSchemeCredential {
  const config = openIdDiscoverySchema.safeParse(
    camelCaseRecordKeys(configDict),
  );
  if (!config.success) {
    throw new Error(
      `Invalid OpenID Connect configuration: ${describeIssues(config.error)}`,
    );
  }

  const credential = camelCaseRecordKeys(credentialDict);
  const values = Object.values(credential);
  const client = openIdClientSchema.safeParse(
    values.length === 1 && isOAuthClient(values[0]) ? values[0] : credential,
  );
  if (!client.success) {
    const missing = client.error.issues.map((issue) => issue.path.join('.'));
    throw new Error(
      `Missing required fields in credential: ${missing.join(', ')}`,
    );
  }

  return {
    authScheme: {type: 'openIdConnect', ...config.data, scopes},
    authCredential: {
      authType: AuthCredentialTypes.OPEN_ID_CONNECT,
      oauth2: client.data,
    },
  };
}

/** Reports whether a value is an OAuth client nested inside a wrapper key. */
function isOAuthClient(value: unknown): value is Record<string, unknown> {
  return isRecord(value) && 'clientId' in value && 'clientSecret' in value;
}

/**
 * Fetches an OpenID Connect discovery document, then builds the scheme and the
 * credential from it.
 *
 * @param openIdUrl The discovery URL, which must be HTTPS and public.
 * @param scopes The scopes to request.
 * @param credentialDict An OAuth client. It must carry `client_id` and
 *   `client_secret`, and may carry `redirect_uri`.
 * @returns The OpenID Connect scheme, carrying `openIdUrl`, and its credential.
 * @throws Error If the document cannot be fetched or parsed, or if the client
 *   is missing a required field.
 */
export async function openIdUrlToSchemeCredential(
  openIdUrl: string,
  scopes: string[],
  credentialDict: Record<string, unknown>,
): Promise<OpenIdSchemeCredential> {
  const configDict = await fetchOpenIdConfiguration(openIdUrl);
  return openIdDictToSchemeCredential(
    {...configDict, openIdConnectUrl: openIdUrl},
    scopes,
    credentialDict,
  );
}

async function fetchOpenIdConfiguration(
  openIdUrl: string,
): Promise<Record<string, unknown>> {
  if (!validateDiscoveryUrl(openIdUrl)) {
    throw new Error(
      `Failed to fetch OpenID configuration from ${openIdUrl}: the URL must be a public HTTPS endpoint.`,
    );
  }

  let response: Response;
  try {
    response = await fetch(openIdUrl, {
      headers: {Accept: 'application/json'},
      // validateDiscoveryUrl only checks the URL given, so following a 3xx
      // would let a validated host redirect discovery to a private address.
      redirect: 'error',
      signal: AbortSignal.timeout(OPENID_DISCOVERY_TIMEOUT_MS),
    });
  } catch (e: unknown) {
    throw new Error(
      `Failed to fetch OpenID configuration from ${openIdUrl}: ${formatError(e)}`,
    );
  }

  if (!response.ok) {
    throw new Error(
      `Failed to fetch OpenID configuration from ${openIdUrl}: HTTP ${response.status}`,
    );
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch (e: unknown) {
    throw new Error(
      `Invalid JSON response from OpenID configuration endpoint ${openIdUrl}: ${formatError(e)}`,
    );
  }

  if (!isRecord(body)) {
    throw new Error(
      `Invalid JSON response from OpenID configuration endpoint ${openIdUrl}: the body is not a JSON object.`,
    );
  }
  return body;
}

/** Builds the `Authorization` header parameter that carries a bearer token. */
function authorizationParam(
  description: string | undefined,
  token: string,
): CredentialParam {
  const name = `${INTERNAL_AUTH_PREFIX}Authorization`;
  return {
    param: {
      originalName: 'Authorization',
      paramLocation: 'header',
      paramSchema: {type: 'string'},
      description: description ?? 'Bearer token',
      name,
      required: true,
    },
    kwargs: {[name]: `Bearer ${token}`},
  };
}

/**
 * Converts an auth scheme and an exchanged credential into the request
 * parameter that carries it, plus the argument value that fills that
 * parameter.
 *
 * Service account, OAuth2 and OpenID Connect credentials reach this function
 * already exchanged for a bearer token.
 *
 * @param authScheme The scheme the tool declares.
 * @param authCredential The credential to send, if the tool has one.
 * @returns The parameter and its argument, or undefined when the credential
 *   carries nothing to send.
 * @throws Error If the scheme and the credential do not go together, or if the
 *   credential uses HTTP basic authentication.
 */
export function credentialToParam(
  authScheme: AuthScheme,
  authCredential?: AuthCredential,
): CredentialParam | undefined {
  if (!authCredential) {
    return undefined;
  }

  if (authScheme.type === 'apiKey' && authCredential.apiKey) {
    if (!isApiKeyLocation(authScheme.in)) {
      throw new Error(`Invalid API Key location: ${authScheme.in}`);
    }
    const name = INTERNAL_AUTH_PREFIX + authScheme.name;
    return {
      param: {
        originalName: authScheme.name,
        paramLocation: authScheme.in,
        paramSchema: {type: 'string'},
        description: authScheme.description ?? '',
        name,
        required: true,
      },
      kwargs: {[name]: authCredential.apiKey},
    };
  }

  if (authCredential.authType === AuthCredentialTypes.HTTP) {
    const credentials = authCredential.http?.credentials;
    if (credentials?.token) {
      return authorizationParam(authScheme.description, credentials.token);
    }
    if (credentials?.username || credentials?.password) {
      throw new Error('Basic Authentication is not supported.');
    }
    throw new Error('Invalid HTTP auth credentials');
  }

  if (authScheme.type === 'oauth2' || authScheme.type === 'openIdConnect') {
    const token = authCredential.http?.credentials?.token;
    return token
      ? authorizationParam(authScheme.description, token)
      : undefined;
  }

  throw new Error('Invalid security scheme and credential combination');
}
