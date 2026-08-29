# BaseAuthCredentialExchanger

`BaseAuthCredentialExchanger` is the base class for code that turns a
configured credential into a credential a request can send. Extend it when you
add support for an authentication scheme that ADK does not exchange for you.

## Introduction

An OpenAPI tool is configured with an `AuthCredential`. That credential is not
always what the HTTP request needs. A service account credential must be traded
for an access token. An OAuth2 credential must be traded for an authorization
URL first, and for an access token afterwards. An API key needs no trade at all.
An exchanger holds the rule for one scheme, so the tool does not have to know
any of them.

The base class defines one method, `exchangeCredential(authScheme,
authCredential?)`. The scheme is required, because the exchanger reads it to
decide what to do. The credential is optional, because some exchangers fall back
to an ambient credential, and some are asked to run before the caller has one.
The method returns the exchanged credential, the original credential when the
scheme needs no exchange, or `undefined` when no request-ready credential exists
yet.

Two neighbouring pieces are easy to confuse with this one:

- `BaseCredentialExchanger` is a separate interface with an `exchange` method
  that takes an object and returns an `ExchangeResult`. It reports whether an
  exchange happened. `CredentialExchangerRegistry` maps an
  `AuthCredentialTypes` value to one of those. `BaseAuthCredentialExchanger`
  is not registered anywhere and returns the credential directly.
- `CredentialExchangeError` reports that an exchange failed.
  `AuthCredentialMissingError` reports that there was nothing to exchange. The
  two are unrelated classes, so a `catch` on one does not catch the other.

## Get started

This exchanger serves an API key scheme, where the credential is already usable.
It rejects a missing credential and returns the credential otherwise.

```ts
import {
  AuthCredential,
  AuthCredentialMissingError,
  AuthScheme,
  BaseAuthCredentialExchanger,
} from '@google/adk';

class ApiKeyExchanger extends BaseAuthCredentialExchanger {
  override async exchangeCredential(
    _authScheme: AuthScheme,
    authCredential?: AuthCredential,
  ): Promise<AuthCredential> {
    if (!authCredential) {
      throw new AuthCredentialMissingError(
        'authCredential is empty. Provide an API key credential.',
      );
    }
    return authCredential;
  }
}
```

The base method ignores both arguments, so it names them `_authScheme` and
`_authCredential`. Your override uses them, so drop the underscore from the ones
you read.

## Failure modes

A subclass that does not override `exchangeCredential` gets the base
implementation, which rejects with
`Error('Subclasses must implement exchangeCredential.')`. The failure is a
rejected promise, not a synchronous throw, so `await` it or attach a `catch`.

Report a missing credential with `AuthCredentialMissingError`, and any other
exchange failure with `CredentialExchangeError`. Keep the credential itself out
of the message: an error string reaches logs and bug reports.
