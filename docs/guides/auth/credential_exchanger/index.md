# BaseAuthCredentialExchanger

`BaseAuthCredentialExchanger` is the base class for the OpenAPI tool auth
layer's credential exchange. A subclass turns the credential a user supplied
into the credential an API call needs. Reach for it when a scheme requires an
exchange step, such as trading a service account key for an access token.

## Introduction

An API key needs no exchange: the value the user configured is the value the
request carries. A service account key does need one, because the API wants a
short-lived token instead. An exchanger is where that step lives, so the tool
that calls the API does not have to know which schemes need it.

The class holds no state and declares one method. `exchangeCredential` takes
the security scheme first, and the credential second because it may be absent.
The base implementation always rejects, so a subclass that forgets to override
it fails on the first call instead of resolving to `undefined`.

`AuthCredentialMissingError` is the error for the case where there is nothing
to exchange. It is separate from `CredentialExchangeError`, which reports that
an exchange ran and failed. The two classes are unrelated, so a `catch` on one
does not catch the other. Keep the credential out of the message: an error
string reaches logs and bug reports.

adk-js also has a newer contract in the same module,
`BaseCredentialExchanger`. It is an interface, it takes one options object with
the credential required and the scheme optional, and it returns an
`ExchangeResult` that reports whether an exchange happened. Implement that one
for new code inside adk-js. `BaseAuthCredentialExchanger` exists for parity
with adk-python's OpenAPI tool auth layer.

## Get started

This exchanger accepts an API key credential and returns it unchanged, because
an API key needs no exchange. It rejects when the caller passes no credential.

```ts
import {
  AuthCredential,
  AuthCredentialMissingError,
  AuthScheme,
  BaseAuthCredentialExchanger,
} from '@google/adk';

class ApiKeyExchanger extends BaseAuthCredentialExchanger {
  override async exchangeCredential(
    authScheme: AuthScheme,
    authCredential?: AuthCredential,
  ): Promise<AuthCredential | undefined> {
    if (!authCredential?.apiKey) {
      throw new AuthCredentialMissingError('API key credential is missing.');
    }
    return authCredential;
  }
}
```

Call it with the scheme and the credential:

```ts
import {AuthCredentialTypes} from '@google/adk';

const scheme: AuthScheme = {type: 'apiKey', name: 'x-api-key', in: 'header'};

const exchanged = await new ApiKeyExchanger().exchangeCredential(scheme, {
  authType: AuthCredentialTypes.API_KEY,
  apiKey: 'some-key',
});
```

## What the base class guarantees

- The class is instantiable, and `new BaseAuthCredentialExchanger()` is legal.
  Calling `exchangeCredential` on it rejects with
  `Error('Subclasses must implement exchangeCredential.')`.
- `authScheme` is required. `authCredential` is optional, so a subclass decides
  whether a missing credential is an error.
- The return type is `Promise<AuthCredential | undefined>`. A subclass may
  resolve to `undefined` when it cannot yet produce a request-ready credential.
- The base class performs no I/O, writes no logs, and holds no fields.
