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
import {ApiParameter} from '../openapi_spec_parser/operation_parser.js';

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

/** Prefix applied to the tool argument name of an injected auth parameter. */
export const INTERNAL_AUTH_PREFIX = '_auth_prefix_vaf_';

/** Timeout for the OpenID Connect discovery request. */
const OPENID_DISCOVERY_TIMEOUT_MS = 10_000;

/** Universe domain assumed for service account keys that predate the field. */
const DEFAULT_UNIVERSE_DOMAIN = 'googleapis.com';

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

/** An OpenID Connect scheme and the credential that satisfies it. */
export interface OpenIdSchemeCredential {
  authScheme: OpenIdConnectWithConfig;
  authCredential: AuthCredential;
}

/** An injected auth parameter and the argument value that fills it. */
export interface CredentialParam {
  param: ApiParameter;
  kwargs: Record<string, string>;
}

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
  universeDomain: z.string().default(DEFAULT_UNIVERSE_DOMAIN),
});

const openIdConfigSchema = z.object({
  authorizationEndpoint: z.string().min(1),
  tokenEndpoint: z.string().min(1),
});

const oauth2FlowBase = {
  refreshUrl: z.string().optional(),
  scopes: z.record(z.string(), z.string()).default({}),
};

const oauth2FlowsSchema = z.object({
  implicit: z
    .object({authorizationUrl: z.string(), ...oauth2FlowBase})
    .optional(),
  password: z.object({tokenUrl: z.string(), ...oauth2FlowBase}).optional(),
  clientCredentials: z
    .object({tokenUrl: z.string(), ...oauth2FlowBase})
    .optional(),
  authorizationCode: z
    .object({
      authorizationUrl: z.string(),
      tokenUrl: z.string(),
      ...oauth2FlowBase,
    })
    .optional(),
});

const apiKeySchemeSchema = z.object({
  name: z.string(),
  in: z.enum(['header', 'query', 'cookie']),
});

const httpSchemeSchema = z.object({
  scheme: z.string(),
  bearerFormat: z.string().optional(),
});

const oauth2SchemeSchema = z.object({flows: oauth2FlowsSchema});

const openIdConnectSchemeSchema = z.object({openIdConnectUrl: z.string()});

function describeIssues(error: z.ZodError): string {
  return error.issues
    .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
    .join('; ');
}

function bearerJwtScheme(): OpenAPIV3.HttpSecurityScheme {
  return {type: 'http', scheme: 'bearer', bearerFormat: 'JWT'};
}

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
      required: false,
    },
    kwargs: {[name]: `Bearer ${token}`},
  };
}

/**
 * Creates an AuthScheme and AuthCredential for an API key or a bearer token.
 *
 * @example
 * // API key in a header.
 * const {authScheme, authCredential} =
 *   tokenToSchemeCredential('apikey', 'header', 'X-API-Key', 'key_value');
 *
 * // OAuth2 bearer token in the Authorization header.
 * const bearer = tokenToSchemeCredential(
 *   'oauth2Token', undefined, undefined, 'token_value');
 *
 * @param tokenType 'apikey' or 'oauth2Token'.
 * @param location Where the API key travels. Ignored for 'oauth2Token'.
 * @param name The name of the header, query parameter or cookie.
 * @param credentialValue The API key or token value.
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
    return {
      authScheme: {type: 'apiKey', in: location, name: name ?? ''},
      authCredential: credentialValue
        ? {authType: AuthCredentialTypes.API_KEY, apiKey: credentialValue}
        : undefined,
    };
  }

  if (tokenType === 'oauth2Token') {
    return {
      authScheme: bearerJwtScheme(),
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
 * Creates an AuthScheme and AuthCredential from a Google service account key.
 *
 * @param config The parsed contents of a service account key file.
 * @param scopes The scopes to request when the key is exchanged.
 * @throws Error If the key is missing a required field.
 */
export function serviceAccountDictToSchemeCredential(
  config: Record<string, unknown>,
  scopes: string[],
): SchemeCredential {
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
    authScheme: bearerJwtScheme(),
    authCredential: {
      authType: AuthCredentialTypes.SERVICE_ACCOUNT,
      serviceAccount: {serviceAccountCredential, scopes},
    },
  };
}

/**
 * Creates an AuthScheme and AuthCredential from a ServiceAccount.
 *
 * @param config The service account to authenticate with.
 */
export function serviceAccountSchemeCredential(
  config: ServiceAccount,
): SchemeCredential {
  return {
    authScheme: bearerJwtScheme(),
    authCredential: {
      authType: AuthCredentialTypes.SERVICE_ACCOUNT,
      serviceAccount: config,
    },
  };
}

/**
 * Builds an OpenID Connect scheme and credential from static configuration.
 *
 * @param configDict An OpenID Connect configuration. It must hold at least
 *   `authorization_endpoint` and `token_endpoint`.
 * @param scopes The scopes to request.
 * @param credentialDict An OAuth client. It must hold at least `client_id` and
 *   `client_secret`, and may hold `redirect_uri`.
 * @throws Error If the configuration or the client is missing a field.
 */
export function openidDictToSchemeCredential(
  configDict: Record<string, unknown>,
  scopes: string[],
  credentialDict: Record<string, unknown>,
): OpenIdSchemeCredential {
  // Both cases must read the same, as they do in adk-python: a caller passes
  // a discovery document or a client secret file exactly as it downloaded it.
  const config = camelCaseKeys(configDict) as Record<string, unknown>;
  const parsedConfig = openIdConfigSchema.safeParse(config);
  if (!parsedConfig.success) {
    throw new Error(
      `Invalid OpenID Connect configuration: ${describeIssues(parsedConfig.error)}`,
    );
  }

  const openIdConnectUrl = config['openIdConnectUrl'];
  const authScheme: OpenIdConnectWithConfig = {
    ...config,
    ...parsedConfig.data,
    type: 'openIdConnect',
    scopes,
    // A static configuration carries no discovery URL of its own.
    openIdConnectUrl:
      typeof openIdConnectUrl === 'string' ? openIdConnectUrl : '',
  };

  return {authScheme, authCredential: openIdCredential(credentialDict)};
}

function openIdCredential(
  credentialDict: Record<string, unknown>,
): AuthCredential {
  let credential = camelCaseKeys(credentialDict) as Record<string, unknown>;
  // A client secret file downloaded from Google nests the client under a
  // single "web" or "installed" key.
  const [inner] = Object.values(credential);
  if (Object.keys(credential).length === 1 && isOAuthClient(inner)) {
    credential = inner;
  }

  const clientId = credential['clientId'];
  const clientSecret = credential['clientSecret'];
  if (typeof clientId !== 'string' || typeof clientSecret !== 'string') {
    // The names are the ones the user wrote in their own JSON.
    const missing: string[] = [];
    if (typeof clientId !== 'string') missing.push('client_id');
    if (typeof clientSecret !== 'string') missing.push('client_secret');
    throw new Error(
      `Missing required fields in credential_dict: ${missing.join(', ')}`,
    );
  }

  const redirectUri = credential['redirectUri'];
  return {
    authType: AuthCredentialTypes.OPEN_ID_CONNECT,
    oauth2: {
      clientId,
      clientSecret,
      redirectUri: typeof redirectUri === 'string' ? redirectUri : undefined,
    },
  };
}

function isOAuthClient(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    'clientId' in value &&
    'clientSecret' in value
  );
}

/**
 * Builds an OpenID Connect scheme and credential from a discovery document.
 *
 * The URL is developer configuration, not model- or end-user-supplied input,
 * so it is fetched as given. This factory applies no host blocklist, which
 * keeps a local identity provider usable.
 *
 * @param openidUrl The OpenID Connect discovery URL.
 * @param scopes The scopes to request.
 * @param credentialDict An OAuth client. It must hold at least `client_id` and
 *   `client_secret`, and may hold `redirect_uri`.
 * @throws Error If the document cannot be fetched or parsed, or if the client
 *   is missing a field.
 */
export async function openidUrlToSchemeCredential(
  openidUrl: string,
  scopes: string[],
  credentialDict: Record<string, unknown>,
): Promise<OpenIdSchemeCredential> {
  let response: Response;
  try {
    response = await fetch(openidUrl, {
      headers: {Accept: 'application/json'},
      signal: AbortSignal.timeout(OPENID_DISCOVERY_TIMEOUT_MS),
    });
  } catch (e: unknown) {
    throw new Error(
      `Failed to fetch OpenID configuration from ${openidUrl}: ${describeError(e)}`,
    );
  }

  if (!response.ok) {
    throw new Error(
      `Failed to fetch OpenID configuration from ${openidUrl}: HTTP ${response.status}`,
    );
  }

  let configDict: unknown;
  try {
    configDict = await response.json();
  } catch (e: unknown) {
    throw new Error(
      `Invalid JSON response from OpenID configuration endpoint ${openidUrl}: ${describeError(e)}`,
    );
  }

  const parsed = z.record(z.string(), z.unknown()).safeParse(configDict);
  if (!parsed.success) {
    throw new Error(
      `Invalid JSON response from OpenID configuration endpoint ${openidUrl}: ${describeIssues(parsed.error)}`,
    );
  }

  return openidDictToSchemeCredential(
    {...parsed.data, openIdConnectUrl: openidUrl},
    scopes,
    credentialDict,
  );
}

function describeError(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * Converts an AuthScheme and an AuthCredential into the request parameter that
 * carries the credential, plus the argument value that fills it.
 *
 * Service account, OAuth2 and OpenID Connect credentials reach this function
 * already exchanged for a bearer token.
 *
 * @returns Undefined when the credential carries nothing to send.
 * @throws Error If the scheme and the credential do not go together.
 */
export function credentialToParam(
  authScheme: AuthScheme,
  authCredential?: AuthCredential,
): CredentialParam | undefined {
  if (!authCredential) {
    return undefined;
  }

  if (authScheme.type === 'apiKey' && authCredential.apiKey) {
    const paramLocation = authScheme.in;
    if (
      paramLocation !== 'header' &&
      paramLocation !== 'query' &&
      paramLocation !== 'cookie'
    ) {
      throw new Error(`Invalid API Key location: ${paramLocation}`);
    }
    const name = INTERNAL_AUTH_PREFIX + authScheme.name;
    return {
      param: {
        originalName: authScheme.name,
        paramLocation,
        paramSchema: {type: 'string'},
        description: authScheme.description ?? '',
        name,
        required: false,
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

/**
 * Converts a security scheme dictionary from an OpenAPI document into an
 * AuthScheme.
 *
 * @example
 * const scheme = dictToAuthScheme({
 *   type: 'apiKey',
 *   in: 'header',
 *   name: 'X-API-Key',
 * });
 *
 * @param data The security scheme, with the key casing an OpenAPI document
 *   uses.
 * @throws Error If the type is missing or unknown, or if the scheme is missing
 *   a field its type requires.
 */
export function dictToAuthScheme(data: Record<string, unknown>): AuthScheme {
  if (!('type' in data)) {
    throw new Error("Missing 'type' field in security scheme dictionary.");
  }

  const type = data['type'];
  switch (type) {
    case 'apiKey':
      return {...data, ...parseScheme(apiKeySchemeSchema, data), type};
    case 'http':
      // Python splits this into HTTPBearer and HTTPBase; openapi-types has one
      // http scheme, and bearerFormat carries through it.
      return {...data, ...parseScheme(httpSchemeSchema, data), type};
    case 'oauth2':
      return {...data, ...parseScheme(oauth2SchemeSchema, data), type};
    case 'openIdConnect':
      return {...data, ...parseScheme(openIdConnectSchemeSchema, data), type};
    default:
      throw new Error(`Invalid security scheme type: ${String(type)}`);
  }
}

function parseScheme<T extends z.ZodType>(
  schema: T,
  data: Record<string, unknown>,
): z.infer<T> {
  const parsed = schema.safeParse(data);
  if (!parsed.success) {
    throw new Error(
      `Invalid security scheme data: ${describeIssues(parsed.error)}`,
    );
  }
  return parsed.data;
}
