# GoogleApiTool

`GoogleApiTool` wraps a `RestApiTool` that calls a Google API, and carries the
credentials that call runs under. Reach for it when a Google API operation needs
OAuth2 user consent, a service account, or a per-API header such as the Google
Ads developer token.

## Introduction

A Google API Discovery document converts into an OpenAPI specification, and
`OpenAPIToolset` turns each operation in that specification into a
`RestApiTool`. A `RestApiTool` knows the endpoint, the parameters and the
request body, but it does not know whose credentials to call with. You supply
those separately through `configureAuthScheme` and `configureAuthCredential`,
which means assembling an `AuthCredential` by hand for every operation.

`GoogleApiTool` owns that step. It copies `name`, `description` and
`isLongRunning` from the tool it wraps, delegates `_getDeclaration` and
`runAsync` straight back to it, and configures the credentials from an options
object. Two credential shapes are supported:

- An OAuth2 client id and client secret. The tool calls as the end user, so
  the run pauses for consent the first time and `ToolAuthHandler` resumes it
  with the token.
- A `ServiceAccount`. The tool calls as the service account, with no user
  interaction. `ServiceAccountCredentialExchanger` mints the access token.

A service account wins when both are given. A lone `clientId` or a lone
`clientSecret` configures nothing, and the tool stays unauthenticated.

`GoogleApiTool` configures the `RestApiTool` instance you pass it, rather than a
copy. The wrapped tool carries the scheme, the credential and the default
headers afterwards.

## Get started

This wraps one operation and calls it as the end user. `RestApiTool` normally
comes out of `OpenAPIToolset`; it is built directly here so the example is
self-contained.

```ts
import {GoogleApiTool, RestApiTool} from '@google/adk';

const restApiTool = new RestApiTool(
  'list_calendars',
  'Lists the calendars on the user calendar list.',
  {
    baseUrl: 'https://www.googleapis.com',
    path: '/calendar/v3/users/me/calendarList',
    method: 'GET',
  },
  {responses: {}},
);

const tool = new GoogleApiTool(restApiTool, {
  clientId: process.env.OAUTH_CLIENT_ID,
  clientSecret: process.env.OAUTH_CLIENT_SECRET,
});
```

Pass `tool` to an agent like any other `BaseTool`. Its declaration and its
result are the wrapped tool's, unchanged.

## Calling as a service account

Some Google APIs are called by an application rather than by a person. Give
`GoogleApiTool` a `ServiceAccount` and it attaches an HTTP bearer scheme plus a
`SERVICE_ACCOUNT` credential, which the exchanger turns into an access token at
call time.

```ts
import {GoogleApiTool, ServiceAccount} from '@google/adk';

const serviceAccount: ServiceAccount = {
  useDefaultCredential: true,
  scopes: ['https://www.googleapis.com/auth/cloud-platform'],
};

const tool = new GoogleApiTool(restApiTool, {serviceAccount});
```

Set `useDefaultCredential` to read Application Default Credentials, or supply a
`serviceAccountCredential` object with the key material.

## Additional headers

Some Google APIs require a header on every request. Google Ads, for example,
requires `developer-token`. Pass `additionalHeaders` and `GoogleApiTool` sets
them as defaults on the wrapped tool.

```ts
const tool = new GoogleApiTool(restApiTool, {
  serviceAccount,
  additionalHeaders: {'developer-token': process.env.ADS_DEVELOPER_TOKEN!},
});
```

A default header never replaces a header the request already carries. A header
parameter the model fills in wins over the default of the same name, and the
`Authorization` header written from the exchanged credential is never
overwritten.

## Configuring credentials later

The constructor options cover the common case. The same two methods are public,
so you can configure a tool after you build it, or switch it from one credential
to the other.

```ts
tool.configureAuth(clientId, clientSecret);
tool.configureSaAuth(serviceAccount);
```

Each call replaces what the wrapped tool holds. Neither method validates the
values it is given; a bad client secret or an unusable service account fails
when the credential is exchanged, not when it is configured.
