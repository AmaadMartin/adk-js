/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

// The Agent Identity authentication scheme for Google Cloud Platform. It names
// an auth provider resource. `GcpAuthProvider` reads the resource name and asks
// the matching Google Cloud credentials service for the credential.
//
// This module is the Agent Identity home of the scheme, and the path the
// integration and `agent_registry` import it from. `auth/auth_schemes` holds
// the one declaration, so the scheme stays a named member of the `AuthScheme`
// union and `auth` does not import `integrations`.
//
// The scheme carries four fields:
//
// - `type` is always `gcpAuthProviderScheme`.
// - `name` is the GCP Auth Provider resource to use.
// - `scopes` is optional, and lists the OAuth2 scopes to request.
// - `continueUri` is optional. It is a redirect URI, distinct from the standard
//   OAuth2 one. It re-authenticates the user to prevent a phishing attack, and
//   it finalises the managed OAuth flow. The Google-hosted OAuth2 redirect URI
//   sends the user on to this continue URI. The agent includes the URI in every
//   three-legged OAuth request it sends to the upstream Agent Identity
//   Credentials service. You host the URI yourself, preferably alongside the
//   agent client's web server.
export type {GcpAuthProviderScheme} from '../../auth/auth_schemes.js';
