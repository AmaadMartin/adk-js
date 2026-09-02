# Auth schemes

An `AuthScheme` says how an API expects a caller to authenticate. Reach for the
types on this page when you declare a scheme on an `AuthConfig`, when the scheme
is one OpenAPI 3.0 does not define, or when the OAuth2 endpoints are only known
at run time.

## Introduction

`AuthScheme` is a union of four things:

- `SecuritySchemeObject` from `openapi-types`, which covers the four schemes
  OpenAPI 3.0 defines: `apiKey`, `http`, `oauth2` and `openIdConnect`.
- `OpenIdConnectWithConfig`, an OpenID Connect scheme with the discovery
  document already flattened onto it.
- `ExtendedOAuth2`, an OAuth2 scheme that names its issuer instead of its
  endpoints.
- `CustomAuthScheme`, the base for a scheme outside the OpenAPI set.

The scheme describes the mechanism. `AuthCredential` holds the secret, and
`AuthConfig` pairs the two. Adding `CustomAuthScheme` to the union makes `type` a
plain `string`, so a comparison such as `scheme.type === 'oauth2'` no longer
narrows the union on its own. Use the guards below rather than `instanceof`: a
project with two copies of an ADK package in one runtime breaks `instanceof`, and
the guards read the value that travels on the wire.

## Get started

Declare a scheme that OpenAPI 3.0 does not define by extending
`CustomAuthScheme` and pinning `type` to your own literal:

```ts
import {AuthScheme, CustomAuthScheme, isCustomAuthScheme} from '@google/adk';

interface MyProviderScheme extends CustomAuthScheme {
  type: 'myProviderScheme';
  name: string;
  scopes?: string[];
}

const scheme: MyProviderScheme = {
  type: 'myProviderScheme',
  name: 'my-provider',
  scopes: ['read'],
};

function routeScheme(candidate: AuthScheme): string {
  return isCustomAuthScheme(candidate) ? candidate.type : 'openapi';
}

routeScheme(scheme); // 'myProviderScheme'
```

The extending interface keeps its own fields typed, so a consumer of
`MyProviderScheme` still gets full checking. `isCustomAuthScheme` returns true
for any `type` outside the `AuthSchemeType` set.

## Discover OAuth2 endpoints from an issuer

`ExtendedOAuth2` carries an `issuerUrl` and leaves the endpoints of each flow
empty. `populateAuthSchemeFromDiscovery` reads the authorization server metadata
published by that issuer, per RFC 8414, and fills the endpoints in:

```ts
import {ExtendedOAuth2, populateAuthSchemeFromDiscovery} from '@google/adk';

const scheme: ExtendedOAuth2 = {
  type: 'oauth2',
  issuerUrl: 'https://issuer.example.com',
  flows: {
    authorizationCode: {authorizationUrl: '', tokenUrl: '', scopes: {}},
  },
};

const discovered = await populateAuthSchemeFromDiscovery(scheme);
if (discovered) {
  scheme.flows.authorizationCode?.tokenUrl; // filled from the issuer metadata
}
```

What it guarantees:

- It mutates `scheme.flows` in place, so the caller sees the endpoints on the
  object it passed in.
- It fills only an endpoint that is empty. An endpoint you set yourself
  survives.
- It returns `false` and logs a warning instead of throwing. The two failure
  paths are a scheme that names no issuer, and an issuer that publishes no
  usable metadata.
- It resolves the issuer through `OAuth2DiscoveryManager`, which refuses a URL
  that is not HTTPS and refuses loopback, private and cloud-metadata
  addresses. Pass your own manager as the second argument to control that
  request.

`ExtendedOAuth2` is experimental and may change without a major version bump.

## Comparing scheme types

`AuthSchemeType` names the four OpenAPI 3.0 scheme types. Its values are the
wire names, so it compares directly against `type`:

```ts
import {AuthScheme, AuthSchemeType, isOAuth2Scheme} from '@google/adk';

function needsConsent(scheme: AuthScheme): boolean {
  return (
    scheme.type === AuthSchemeType.OAUTH2 ||
    scheme.type === AuthSchemeType.OPEN_ID_CONNECT
  );
}

function scopesOf(scheme: AuthScheme): string[] {
  if (!isOAuth2Scheme(scheme)) {
    return [];
  }
  return Object.keys(scheme.flows.authorizationCode?.scopes ?? {});
}
```

`isOAuth2Scheme` narrows to an OAuth2 scheme that declares its flows.
`isExtendedOAuth2` narrows further, to one that also carries a non-empty
`issuerUrl`.
