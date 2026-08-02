# Agent Identity auth

Obtains an access token scoped to the **end user** of an agent from a Google
Cloud credentials service, instead of running every user's traffic under one
static service-account key.

Two backends are supported, selected by the resource name in the auth scheme:

| Resource name                            | Backend                            |
| ---------------------------------------- | ---------------------------------- |
| `projects/*/locations/*/authProviders/*` | Agent Identity Credentials service |
| `projects/*/locations/*/connectors/*`    | IAM Connector Credentials service  |

> **Status:** the ADK TypeScript runtime does not consult `AuthProviderRegistry`
> yet — nothing in `core/src` calls `getProvider()`. `GcpAuthProvider` is
> therefore usable as a library (register it, or call it directly) but is not
> yet invoked automatically during a tool call. Wiring the registry into
> credential resolution is tracked separately.

## Usage

### 1. Register the provider

```ts
import {
  AuthProviderRegistry,
  GCP_AUTH_PROVIDER_SCHEME_TYPE,
  GcpAuthProvider,
} from '@google/adk';

const registry = new AuthProviderRegistry();
registry.register(GCP_AUTH_PROVIDER_SCHEME_TYPE, new GcpAuthProvider());
```

### 2. Describe the auth provider resource

```ts
import type {GcpAuthProviderScheme} from '@google/adk';

const authScheme: GcpAuthProviderScheme = {
  type: 'gcpAuthProviderScheme',
  name: 'projects/my-project/locations/global/authProviders/my-jira-provider',
  scopes: ['https://example.com/auth/jira.read'],
  // Where the Google-hosted OAuth2 redirect sends the user to finalize the
  // managed OAuth flow. Host it alongside your agent's web server.
  continueUri: 'https://my-agent.example.com/continue',
};
```

### 3. Request a credential

```ts
const provider = registry.getProvider(authScheme);
const credential = await provider?.getAuthCredential({authScheme}, context);
```

`context` must expose the end user's `userId` (an ADK `Context` does). The call
resolves to one of:

- an `http` credential holding a bearer token or a custom header, when the user
  already consented (or the provider issues an API key);
- an `oauth2` credential holding only `authUri` and `nonce`, meaning the user
  still has to consent — drive them through it and retry on a later turn;
- `undefined`, when the service reported no state this code understands.

A request that comes back `pending` is polled for up to 10 seconds at 1 second
intervals before the call gives up.

## Manual verification

The credentials services are not reachable from CI, so the behaviour above is
covered by unit tests against a mocked client. To exercise the real thing:

1. Provision an Agent Identity auth provider (or an IAM connector) in a GCP
   project and note its full resource name.
2. Make Application Default Credentials available
   (`gcloud auth application-default login`).
3. Optionally point the client at a test instance:

   ```bash
   export AGENT_IDENTITY_CREDENTIALS_TARGET_HOST=my-test-host.example.com
   # or, for a connector resource name:
   export IAM_CONNECTOR_CREDENTIALS_TARGET_HOST=my-test-host.example.com
   ```

   A bare host gains an `https://` scheme; a value with a scheme is used as-is.

4. Run the three-step snippet above with a real `userId`. The first call returns
   an `oauth2` credential; open its `authUri` in a browser, complete consent,
   then call again — the second call returns the bearer token.
