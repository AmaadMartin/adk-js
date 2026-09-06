/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The client-to-server credential model of {@link ToolboxToolset}, and its
 * translation into the headers the Toolbox client sends with every request.
 *
 * The `@toolbox-sdk/core` client has no credential abstraction: it only takes
 * a header map whose values are strings or per-request getters. This module
 * holds the declarative model and the one function that turns it into that
 * map, so the toolset itself stays about loading tools.
 */

import {GoogleAuth} from 'google-auth-library';

import {AuthCredential, AuthCredentialTypes} from '../auth/auth_credential.js';
import {AuthScheme} from '../auth/auth_schemes.js';
import {AuthConfig} from '../auth/auth_tool.js';
import {formatError} from '../utils/error_utils.js';
import {logger} from '../utils/logger.js';

/** How a `ToolboxToolset` authenticates itself to the Toolbox server. */
export enum ToolboxCredentialType {
  /** Send nothing; the server relies on its own identity. */
  TOOLBOX_IDENTITY = 'TOOLBOX_IDENTITY',
  /** Mint a Google ID token from the agent's application default credentials. */
  WORKLOAD_IDENTITY = 'WORKLOAD_IDENTITY',
  /** Ask the end user to consent through ADK's interactive OAuth2 flow. */
  USER_IDENTITY = 'USER_IDENTITY',
  /** Send a token the caller already holds. */
  MANUAL_TOKEN = 'MANUAL_TOKEN',
  /** Send an access token from a caller-supplied auth client. */
  MANUAL_CREDS = 'MANUAL_CREDS',
  /** Send an API key in a named header. */
  API_KEY = 'API_KEY',
}

/**
 * A client-to-server header value: a fixed string, or a getter the SDK calls
 * for every request.
 */
export type ToolboxHeaderValue = string | (() => string | Promise<string>);

/**
 * The slice of an auth client that {@link ToolboxCredentialType.MANUAL_CREDS}
 * needs. Typed structurally so that any client with this method fits, and so
 * that no `google-auth-library` class appears in a public ADK signature.
 */
export interface ToolboxTokenSource {
  getAccessToken(): Promise<{token?: string | null}>;
}

/**
 * A client-to-server credential.
 *
 * Every field is optional and is validated for the chosen `type` when the
 * client is built, mirroring adk-python. Build one with
 * {@link ToolboxCredentialStrategy} rather than by hand: each factory takes
 * the fields its strategy requires.
 */
export interface ToolboxCredentialConfig {
  /** Which strategy the remaining fields configure. */
  type: ToolboxCredentialType;
  /** `WORKLOAD_IDENTITY`: the audience of the minted ID token. */
  targetAudience?: string;
  /** `USER_IDENTITY`: the OAuth2 client id. */
  clientId?: string;
  /** `USER_IDENTITY`: the OAuth2 client secret. */
  clientSecret?: string;
  /** `USER_IDENTITY`: the scopes consent is requested for. */
  scopes?: string[];
  /** `MANUAL_TOKEN`: the token to send. */
  token?: string;
  /** `MANUAL_TOKEN`: the authorization scheme, `Bearer` by default. */
  scheme?: string;
  /** `MANUAL_CREDS`: the auth client the access token is read from. */
  credentials?: ToolboxTokenSource;
  /** `API_KEY`: the key to send. */
  apiKey?: string;
  /** `API_KEY` and `USER_IDENTITY`: the header the credential is sent in. */
  headerName?: string;
}

/** Messages raised for a credential the toolset cannot use. */
enum ToolboxCredentialError {
  WORKLOAD_IDENTITY_AUDIENCE = 'targetAudience is required for WORKLOAD_IDENTITY',
  MANUAL_TOKEN_TOKEN = 'token is required for MANUAL_TOKEN',
  MANUAL_CREDS_OBJECT = 'credentials object is required for MANUAL_CREDS',
  API_KEY_FIELDS = 'apiKey and headerName are required for API_KEY',
  USER_IDENTITY_CLIENT = 'USER_IDENTITY requires clientId and clientSecret',
  API_KEY_SCHEME = 'API Key credentials require the authScheme definition.',
  API_KEY_HEADER_NAME = 'API Key scheme must define the header name.',
  RAW_AUTH_CREDENTIAL = 'AuthConfig must have a rawAuthCredential.',
  UNSUPPORTED_CREDENTIAL_TYPE = 'Unsupported ADK credential type',
  UNSUPPORTED_HTTP_SCHEME = 'Unsupported HTTP authentication scheme',
  UNSUPPORTED_API_KEY_LOCATION = 'Unsupported API Key location',
}

/** The authorization scheme `MANUAL_TOKEN` uses when none is given. */
const DEFAULT_TOKEN_SCHEME = 'Bearer';

/** The header `API_KEY` uses when none is given. */
const DEFAULT_API_KEY_HEADER = 'X-API-Key';

/** The header `USER_IDENTITY` uses when none is given. */
const DEFAULT_USER_IDENTITY_HEADER = 'Authorization';

/** The scopes `USER_IDENTITY` requests consent for when none are given. */
const DEFAULT_USER_IDENTITY_SCOPES = ['openid', 'profile', 'email'];

/** Google's OAuth2 authorization endpoint, used by `USER_IDENTITY`. */
const GOOGLE_AUTHORIZATION_URL = 'https://accounts.google.com/o/oauth2/auth';

/** Google's OAuth2 token endpoint, used by `USER_IDENTITY`. */
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';

/** Formats a token as an `Authorization` header value, or `''` if absent. */
function bearer(token?: string | null): string {
  return token ? `${DEFAULT_TOKEN_SCHEME} ${token}` : '';
}

/**
 * Mints a Google ID token for `audience` from application default
 * credentials, falling back to the plain access token when no ID token can be
 * minted. Resolves to `''` when neither is available, so an unauthenticated
 * request reaches the server and the server decides, as adk-python does.
 */
async function fetchWorkloadAuthorization(audience: string): Promise<string> {
  const auth = new GoogleAuth();
  try {
    const client = await auth.getIdTokenClient(audience);
    return bearer(await client.idTokenProvider.fetchIdToken(audience));
  } catch (err: unknown) {
    logger.debug(
      `Toolbox WORKLOAD_IDENTITY could not mint an ID token for ${audience}, ` +
        `falling back to the default credentials: ${formatError(err)}`,
    );
    return bearer(await auth.getAccessToken());
  }
}

/**
 * Translates a credential into the headers the Toolbox client sends.
 *
 * Exactly one header is produced, except for
 * {@link ToolboxCredentialType.TOOLBOX_IDENTITY}, which produces none. A
 * header whose value depends on the request is returned as a getter, which
 * the SDK resolves per request.
 *
 * @param config The credential to translate.
 * @param readUserToken Reads the end user's access token for the invocation
 *   in progress. Only called for `USER_IDENTITY`.
 * @return The headers to merge over the caller's `additionalHeaders`.
 * @throws If the credential is missing a field its type requires.
 */
export function credentialClientHeaders(
  config: ToolboxCredentialConfig,
  readUserToken: () => string | undefined,
): Record<string, ToolboxHeaderValue> {
  switch (config.type) {
    case ToolboxCredentialType.TOOLBOX_IDENTITY:
      return {};

    case ToolboxCredentialType.WORKLOAD_IDENTITY: {
      const audience = config.targetAudience;
      if (!audience) {
        throw new Error(ToolboxCredentialError.WORKLOAD_IDENTITY_AUDIENCE);
      }
      return {Authorization: () => fetchWorkloadAuthorization(audience)};
    }

    case ToolboxCredentialType.MANUAL_TOKEN: {
      if (!config.token) {
        throw new Error(ToolboxCredentialError.MANUAL_TOKEN_TOKEN);
      }
      const scheme = config.scheme || DEFAULT_TOKEN_SCHEME;
      return {Authorization: `${scheme} ${config.token}`};
    }

    case ToolboxCredentialType.MANUAL_CREDS: {
      const source = config.credentials;
      if (!source) {
        throw new Error(ToolboxCredentialError.MANUAL_CREDS_OBJECT);
      }
      return {
        Authorization: async () =>
          bearer((await source.getAccessToken()).token),
      };
    }

    case ToolboxCredentialType.USER_IDENTITY: {
      const headerName = config.headerName || DEFAULT_USER_IDENTITY_HEADER;
      return {[headerName]: () => bearer(readUserToken())};
    }

    case ToolboxCredentialType.API_KEY: {
      if (!config.apiKey || !config.headerName) {
        throw new Error(ToolboxCredentialError.API_KEY_FIELDS);
      }
      return {[config.headerName]: config.apiKey};
    }
  }
}

/**
 * Builds the ADK auth config that drives the `USER_IDENTITY` consent flow.
 *
 * @param config The `USER_IDENTITY` credential.
 * @param credentialKey Key the credential service stores the result under.
 * @return An OAuth2 authorization-code config for Google's endpoints.
 * @throws If the credential carries no `clientId` or no `clientSecret`.
 */
export function userIdentityAuthConfig(
  config: ToolboxCredentialConfig,
  credentialKey: string,
): AuthConfig {
  const {clientId, clientSecret} = config;
  if (!clientId || !clientSecret) {
    throw new Error(ToolboxCredentialError.USER_IDENTITY_CLIENT);
  }
  // An empty scope list falls back to the defaults, as adk-python does.
  const scopes = config.scopes?.length
    ? config.scopes
    : DEFAULT_USER_IDENTITY_SCOPES;
  return {
    authScheme: {
      type: 'oauth2',
      flows: {
        authorizationCode: {
          authorizationUrl: GOOGLE_AUTHORIZATION_URL,
          tokenUrl: GOOGLE_TOKEN_URL,
          scopes: Object.fromEntries(scopes.map((scope) => [scope, ''])),
        },
      },
    },
    rawAuthCredential: {
      authType: AuthCredentialTypes.OAUTH2,
      oauth2: {clientId, clientSecret},
    },
    credentialKey,
  };
}

/** Reads the header name an API key scheme sends the key in. */
function apiKeyHeaderName(authScheme: AuthScheme): string {
  if (!('name' in authScheme) || !authScheme.name) {
    throw new Error(ToolboxCredentialError.API_KEY_HEADER_NAME);
  }
  if (authScheme.in.toLowerCase() !== 'header') {
    throw new Error(
      `${ToolboxCredentialError.UNSUPPORTED_API_KEY_LOCATION}: ` +
        `${authScheme.in}. Only 'header' is supported.`,
    );
  }
  return authScheme.name;
}

/**
 * Factories for the supported credential strategies, mirroring adk-python's
 * `CredentialStrategy`. Grouped rather than exported loose so that names as
 * general as `apiKey` and `manualToken` stay qualified at the call site.
 */
export const ToolboxCredentialStrategy = Object.freeze({
  /** Sends no credential; the server relies on its own identity. */
  toolboxIdentity(): ToolboxCredentialConfig {
    return {type: ToolboxCredentialType.TOOLBOX_IDENTITY};
  },

  /**
   * Mints a Google-signed ID token for `targetAudience` from the agent's
   * application default credentials, for Cloud Run, GKE, or a local
   * `gcloud auth` login.
   */
  workloadIdentity(targetAudience: string): ToolboxCredentialConfig {
    return {type: ToolboxCredentialType.WORKLOAD_IDENTITY, targetAudience};
  },

  /** Alias of `workloadIdentity`. */
  applicationDefaultCredentials(
    targetAudience: string,
  ): ToolboxCredentialConfig {
    return ToolboxCredentialStrategy.workloadIdentity(targetAudience);
  },

  /**
   * Asks the end user to consent through ADK's interactive OAuth2 flow, and
   * sends the resulting token. Defaults to the `openid`, `profile` and
   * `email` scopes, in the `Authorization` header.
   */
  userIdentity(options: {
    clientId: string;
    clientSecret: string;
    scopes?: string[];
    headerName?: string;
  }): ToolboxCredentialConfig {
    return {
      type: ToolboxCredentialType.USER_IDENTITY,
      clientId: options.clientId,
      clientSecret: options.clientSecret,
      scopes: options.scopes ?? [...DEFAULT_USER_IDENTITY_SCOPES],
      headerName: options.headerName ?? DEFAULT_USER_IDENTITY_HEADER,
    };
  },

  /** Sends `token` in the `Authorization` header, as `Bearer` by default. */
  manualToken(
    token: string,
    scheme: string = DEFAULT_TOKEN_SCHEME,
  ): ToolboxCredentialConfig {
    return {type: ToolboxCredentialType.MANUAL_TOKEN, token, scheme};
  },

  /** Sends the access token `credentials` yields, refreshing as it needs to. */
  manualCredentials(credentials: ToolboxTokenSource): ToolboxCredentialConfig {
    return {type: ToolboxCredentialType.MANUAL_CREDS, credentials};
  },

  /** Sends `key` in `headerName`, `X-API-Key` by default. */
  apiKey(
    key: string,
    headerName: string = DEFAULT_API_KEY_HEADER,
  ): ToolboxCredentialConfig {
    return {type: ToolboxCredentialType.API_KEY, apiKey: key, headerName};
  },

  /**
   * Converts an ADK credential the agent already holds.
   *
   * @param authCredential The credential carrying the secret or token.
   * @param authScheme The scheme it belongs to. Required for an API key,
   *   which takes its header name from the scheme.
   * @return The equivalent Toolbox credential.
   * @throws If the credential type, the HTTP scheme, or the API key location
   *   is not one the Toolbox client can send.
   */
  fromAdkCredentials(
    authCredential: AuthCredential,
    authScheme?: AuthScheme,
  ): ToolboxCredentialConfig {
    const {oauth2, http, apiKey} = authCredential;
    if (authCredential.authType === AuthCredentialTypes.OAUTH2 && oauth2) {
      // ADK's OAuth2Auth carries no scopes, so the default scopes apply.
      return ToolboxCredentialStrategy.userIdentity({
        clientId: oauth2.clientId ?? '',
        clientSecret: oauth2.clientSecret ?? '',
      });
    }

    if (authCredential.authType === AuthCredentialTypes.HTTP && http) {
      const scheme = (http.scheme || '').toLowerCase();
      if (scheme === 'bearer' && http.credentials.token) {
        return ToolboxCredentialStrategy.manualToken(
          http.credentials.token,
          DEFAULT_TOKEN_SCHEME,
        );
      }
      throw new Error(
        `${ToolboxCredentialError.UNSUPPORTED_HTTP_SCHEME}: ${scheme}`,
      );
    }

    if (authCredential.authType === AuthCredentialTypes.API_KEY && apiKey) {
      if (!authScheme) {
        throw new Error(ToolboxCredentialError.API_KEY_SCHEME);
      }
      return ToolboxCredentialStrategy.apiKey(
        apiKey,
        apiKeyHeaderName(authScheme),
      );
    }

    throw new Error(
      `${ToolboxCredentialError.UNSUPPORTED_CREDENTIAL_TYPE}: ` +
        `${authCredential.authType}`,
    );
  },

  /**
   * Converts an ADK auth config, using its raw credential and its scheme.
   *
   * @param authConfig The config to convert.
   * @return The equivalent Toolbox credential.
   * @throws If the config carries no `rawAuthCredential`.
   */
  fromAdkAuthConfig(authConfig: AuthConfig): ToolboxCredentialConfig {
    if (!authConfig.rawAuthCredential) {
      throw new Error(ToolboxCredentialError.RAW_AUTH_CREDENTIAL);
    }
    return ToolboxCredentialStrategy.fromAdkCredentials(
      authConfig.rawAuthCredential,
      authConfig.authScheme,
    );
  },
});
