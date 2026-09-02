/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Narrows an untyped value to a plain object, rejecting `null` and arrays.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Represents the secret token value for HTTP authentication, like user name,
 * password, oauth token, etc.
 */
export interface HttpCredentials {
  username?: string;
  password?: string;
  token?: string;
}

/** The fields {@link toHttpCredentials} keeps; every other key is dropped. */
const HTTP_CREDENTIAL_FIELDS = ['username', 'password', 'token'] as const;

/**
 * Builds {@link HttpCredentials} from an untyped record, keeping only the
 * modelled fields.
 *
 * A provider response often carries fields this model does not declare. They
 * are dropped rather than copied, so that an unexpected secret cannot ride
 * along inside a credential.
 *
 * @param data The record to read, typically parsed from a provider response.
 * @returns A new object holding at most `username`, `password` and `token`. A
 *   field that is absent, `undefined` or `null` is omitted.
 * @throws {Error} If `data` is not a plain object, or if a modelled field is
 *   present and not a string. The message names the field and its type. It
 *   never contains the offending value.
 */
export function toHttpCredentials(data: unknown): HttpCredentials {
  if (!isRecord(data)) {
    throw new Error('Invalid HTTP credentials: expected an object.');
  }
  const credentials: HttpCredentials = {};
  for (const field of HTTP_CREDENTIAL_FIELDS) {
    const value = data[field];
    if (value === undefined || value === null) {
      continue;
    }
    if (typeof value !== 'string') {
      throw new Error(
        `Invalid HTTP credentials: '${field}' must be a string, got ${typeof value}.`,
      );
    }
    credentials[field] = value;
  }
  return credentials;
}

/**
 * The credentials and metadata for HTTP authentication.
 */
export interface HttpAuth {
  /**
   * The name of the HTTP Authorization scheme to be used in the Authorization
   * header as defined in RFC7235. The values used SHOULD be registered in the
   * IANA Authentication Scheme registry.
   * Examples: 'basic', 'bearer'
   */
  scheme: string;
  credentials: HttpCredentials;

  /**
   * Additional HTTP headers to include in the request.
   */
  additionalHeaders?: Record<string, string>;
}

/**
 * The client authentication method used at the OAuth2 token endpoint
 * (RFC 6749 / RFC 7591).
 */
export type TokenEndpointAuthMethod =
  | 'client_secret_basic'
  | 'client_secret_post'
  | 'client_secret_jwt'
  | 'private_key_jwt';

/** The token endpoint auth method assumed when a credential omits one. */
export const DEFAULT_TOKEN_ENDPOINT_AUTH_METHOD: TokenEndpointAuthMethod =
  'client_secret_basic';

/**
 * Represents credential value and its metadata for a OAuth2 credential.
 */
export interface OAuth2Auth {
  clientId?: string;
  clientSecret?: string;
  /**
   * tool or adk can generate the authUri with the state info thus client can
   * verify the state
   */
  authUri?: string;
  nonce?: string;
  state?: string;
  codeVerifier?: string;
  /**
   * tool or adk can decide the redirect_uri if they don't want client to decide
   */
  redirectUri?: string;
  authResponseUri?: string;
  authCode?: string;
  accessToken?: string;
  refreshToken?: string;
  idToken?: string;
  expiresAt?: number;
  expiresIn?: number;
  audience?: string;

  /**
   * The OAuth2 `prompt` parameter, forwarded on the authorization request.
   * When unset, callers use 'consent'.
   */
  prompt?: string;

  /**
   * The PKCE code challenge method. Only 'S256' is supported by the flows in
   * this repo.
   */
  codeChallengeMethod?: string;

  tokenEndpointAuthMethod?: TokenEndpointAuthMethod;
}

/**
 * Builds an OAuth2 credential with the defaults the reference implementation
 * applies at construction.
 *
 * @param init The fields to set. A `tokenEndpointAuthMethod` that is absent or
 *   `undefined` is filled in with {@link DEFAULT_TOKEN_ENDPOINT_AUTH_METHOD}.
 * @returns A new credential. `init` is not modified.
 */
export function createOAuth2Auth(init: OAuth2Auth = {}): OAuth2Auth {
  return {
    ...init,
    tokenEndpointAuthMethod:
      init.tokenEndpointAuthMethod ?? DEFAULT_TOKEN_ENDPOINT_AUTH_METHOD,
  };
}

/**
 * Represents Google Service Account configuration.
 * @example
 * config = {
 *   type: "service_account",
 *   projectId: "your_project_id",
 *   privateKeyId: "your_private_key_id",
 *   privateKey: "-----BEGIN PRIVATE KEY-----...",
 *   clientEmail: "...@....iam.gserviceaccount.com",
 *   clientId: "your_client_id",
 *   authUri: "https://accounts.google.com/o/oauth2/auth",
 *   tokenUri: "https://oauth2.googleapis.com/token",
 *   authProviderX509CertUrl: "https://www.googleapis.com/oauth2/v1/certs",
 *   clientX509CertUrl: "https://www.googleapis.com/robot/v1/metadata/x509/...",
 *   universeDomain: "googleapis.com",
 * }
 */
export interface ServiceAccountCredential {
  /**
   * The type should be 'service_account'.
   */
  type: 'service_account';

  /**
   * The project ID of the Google Cloud project.
   */
  projectId: string;

  /**
   * The ID of the private key.
   */
  privateKeyId: string;

  /**
   * The private key value.
   */
  privateKey: string;

  /**
   * The client email.
   */
  clientEmail: string;

  /**
   * The client ID.
   */
  clientId: string;

  /**
   * The authorization URI.
   */
  authUri: string;

  /**
   * The token URI.
   */
  tokenUri: string;

  /**
   * URL for auth provider's X.509 cert.
   */
  authProviderX509CertUrl: string;

  /**
   * URL for the client's X.509 cert.
   */
  clientX509CertUrl: string;

  /**
   * The universe domain.
   */
  universeDomain: string;
}

/**
 * Represents Google Service Account configuration.
 */
export interface ServiceAccount {
  serviceAccountCredential?: ServiceAccountCredential;
  scopes?: string[];
  useDefaultCredential?: boolean;

  /**
   * If true, get an ID token instead of an access token.
   */
  useIdToken?: boolean;

  /**
   * The audience for the ID token. Required if useIdToken is true.
   */
  audience?: string;
}

/**
 * Throws when a service account configuration cannot be exchanged for a token.
 *
 * @param serviceAccount The configuration to check.
 * @throws {Error} If `serviceAccountCredential` is absent while
 *   `useDefaultCredential` is not set, or if `audience` is absent while
 *   `useIdToken` is set. The message names the field. It never contains any
 *   part of the credential.
 */
export function validateServiceAccount(serviceAccount: ServiceAccount): void {
  if (
    !serviceAccount.useDefaultCredential &&
    !serviceAccount.serviceAccountCredential
  ) {
    throw new Error(
      'serviceAccountCredential is required when useDefaultCredential is false.',
    );
  }
  if (serviceAccount.useIdToken && !serviceAccount.audience) {
    throw new Error(
      "audience is required when useIdToken is true. Set it to the URL of the target service (e.g. 'https://my-service.run.app').",
    );
  }
}

/**
 * Validates a service account configuration and returns it.
 *
 * @param init The configuration to validate.
 * @returns `init`, unchanged.
 * @throws {Error} See {@link validateServiceAccount}.
 */
export function createServiceAccount(init: ServiceAccount): ServiceAccount {
  validateServiceAccount(init);
  return init;
}

/*
 * Represents the type of authentication credential.
 */
export enum AuthCredentialTypes {
  /**
   * API Key credential:
   * @see {@link https://swagger.io/docs/specification/v3_0/authentication/api-keys/}
   */
  API_KEY = 'apiKey',

  /**
   * Credentials for HTTP Auth schemes:
   * @see {@link https://www.iana.org/assignments/http-authschemes/http-auth-schemes.xhtml}
   */
  HTTP = 'http',

  /**
   * OAuth2 credentials:
   * @see {@link https://swagger.io/docs/specification/v3_0/authentication/oauth2/}
   */
  OAUTH2 = 'oauth2',

  /**
   * Open ID Connect credentials:
   * @see {@link https://swagger.io/docs/specification/v3_0/authentication/openid-connect-discovery/}
   */
  OPEN_ID_CONNECT = 'openIdConnect',

  /**
   * Service Account credentials:
   * @see {@link https://cloud.google.com/iam/docs/service-account-creds}
   */
  SERVICE_ACCOUNT = 'serviceAccount',
}

/**
 * Data class representing an authentication credential.
 *
 * To exchange for the actual credential, please use
 * CredentialExchanger.exchangeCredential().
 *
 * @example
 * // API Key Auth
 * const authCredential: AuthCredential = {
 *   authType: AuthCredentialTypes.API_KEY,
 *   apiKey: "your_api_key",
 * };
 *
 * @example
 * // HTTP Auth
 * const authCredential: AuthCredential = {
 *   authType: AuthCredentialTypes.HTTP,
 *   http: {
 *     scheme: "basic",
 *     credentials: {
 *       username: "user",
 *       password: "password",
 *     },
 *   }
 * }
 *
 * @example
 * // OAuth2 Bearer Token in HTTP Header
 * const authCredential: AuthCredential = {
 *   authType: AuthCredentialTypes.HTTP,
 *   http: {
 *     scheme: "bearer",
 *     credentials: {
 *       token: "your_access_token",
 *     },
 *   }
 * }
 *
 * @example
 * // OAuth2 Auth with Authorization Code Flow
 * const authCredential: AuthCredential = {
 *   authType: AuthCredentialTypes.OAUTH2,
 *   oauth2: {
 *     clientId: "your_client_id",
 *     clientSecret: "your_client_secret",
 *   }
 * }
 *
 * @example:
 * // Open ID Connect Auth
 * const authCredential: AuthCredential = {
 *   authType: AuthCredentialTypes.OPEN_ID_CONNECT,
 *   oauth2: {
 *     clientId: "1234",
 *     clientSecret: "secret",
 *     redirectUri: "https://example.com",
 *     scopes: ["scope1", "scope2"],
 *   }
 * }
 *
 * @example:
 * // Auth with resource reference
 * const authCredential: AuthCredential = {
 *   authType: AuthCredentialTypes.API_KEY,
 *   resourceRef: "projects/1234/locations/us-central1/resources/resource1"
 * }
 */
export interface AuthCredential {
  authType: AuthCredentialTypes;

  /**
   * Resource reference for the credential.
   * This will be supported in the future.
   */
  resourceRef?: string;

  apiKey?: string;
  http?: HttpAuth;
  serviceAccount?: ServiceAccount;
  oauth2?: OAuth2Auth;
}

/** The placeholder rendered in place of an unmodelled field's value. */
export const REDACTED = '<redacted>';

/** The names of the credential shapes {@link redactAuthCredential} walks. */
type CredentialShapeName =
  | 'authCredential'
  | 'httpAuth'
  | 'httpCredentials'
  | 'oauth2Auth'
  | 'serviceAccount'
  | 'serviceAccountCredential';

/**
 * How one credential shape renders. Any key absent from all three sets is
 * unmodelled, so the walker redacts its value.
 */
interface CredentialShape {
  /** Declared keys whose value is safe to render. */
  readonly visible: ReadonlySet<string>;
  /** Declared keys omitted from the output because the value is a secret. */
  readonly secret: ReadonlySet<string>;
  /** Declared keys holding a nested credential shape. */
  readonly nested: Readonly<Record<string, CredentialShapeName>>;
}

/**
 * Mirrors the interfaces above. Add a field to one of them and it must be
 * added here too: the walker redacts anything this table does not list, so a
 * missing entry hides the value rather than leaking it.
 */
const CREDENTIAL_SHAPES: Readonly<
  Record<CredentialShapeName, CredentialShape>
> = {
  authCredential: {
    visible: new Set(['authType', 'resourceRef']),
    secret: new Set(['apiKey']),
    nested: {
      http: 'httpAuth',
      serviceAccount: 'serviceAccount',
      oauth2: 'oauth2Auth',
    },
  },
  httpAuth: {
    visible: new Set(['scheme']),
    secret: new Set(['additionalHeaders']),
    nested: {credentials: 'httpCredentials'},
  },
  httpCredentials: {
    visible: new Set(['username']),
    secret: new Set(['password', 'token']),
    nested: {},
  },
  oauth2Auth: {
    visible: new Set([
      'clientId',
      'authUri',
      'nonce',
      'state',
      'redirectUri',
      'expiresAt',
      'expiresIn',
      'audience',
      'prompt',
      'codeChallengeMethod',
      'tokenEndpointAuthMethod',
    ]),
    secret: new Set([
      'clientSecret',
      'codeVerifier',
      'authResponseUri',
      'authCode',
      'accessToken',
      'refreshToken',
      'idToken',
    ]),
    nested: {},
  },
  serviceAccount: {
    visible: new Set([
      'scopes',
      'useDefaultCredential',
      'useIdToken',
      'audience',
    ]),
    secret: new Set([]),
    nested: {serviceAccountCredential: 'serviceAccountCredential'},
  },
  serviceAccountCredential: {
    visible: new Set([
      'type',
      'projectId',
      'clientEmail',
      'clientId',
      'authUri',
      'tokenUri',
      'authProviderX509CertUrl',
      'clientX509CertUrl',
      'universeDomain',
    ]),
    secret: new Set(['privateKeyId', 'privateKey']),
    nested: {},
  },
};

/** Projects one object through its shape, recursing into nested shapes. */
function redactShape(
  source: object,
  shape: CredentialShape,
): Record<string, unknown> {
  const redacted: Record<string, unknown> = {};
  const entries: Array<[string, unknown]> = Object.entries(source);
  for (const [key, value] of entries) {
    if (value === undefined || shape.secret.has(key)) {
      continue;
    }
    const nested = shape.nested[key];
    if (nested !== undefined) {
      redacted[key] = isRecord(value)
        ? redactShape(value, CREDENTIAL_SHAPES[nested])
        : REDACTED;
    } else {
      redacted[key] = shape.visible.has(key) ? value : REDACTED;
    }
  }
  return redacted;
}

/**
 * Returns a log-safe view of a credential: declared secret fields are omitted,
 * and the value of every field this module does not declare is replaced with
 * {@link REDACTED}. The key stays visible, so the redaction is apparent while
 * debugging.
 *
 * TypeScript has no `repr` hook, so this must be called at the point a
 * credential is logged or serialized into an error. The argument is not
 * modified and the secrets remain readable on it.
 *
 * @param credential The credential to project.
 * @returns A new plain object safe to log.
 */
export function redactAuthCredential(
  credential: AuthCredential,
): Record<string, unknown> {
  return redactShape(credential, CREDENTIAL_SHAPES.authCredential);
}
