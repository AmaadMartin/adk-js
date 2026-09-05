/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Ported from adk-python `main`:
 * `src/google/adk/integrations/agent_identity/gcp_auth_provider_scheme.py`.
 *
 * The module declares types only, so the assertions are type-level plus the
 * wire names the scheme serialises to.
 */

import {
  AuthConfig,
  AuthScheme,
  CustomAuthScheme,
  GcpAuthProviderScheme,
} from '@google/adk';
// The relative import is the assertion: it pins that the legacy
// `agent_registry` path still resolves, and to the same declaration.
import {describe, expect, expectTypeOf, it} from 'vitest';
import {GcpAuthProviderScheme as SchemeFromAgentRegistry} from '../../../src/integrations/agent_registry/types.js';

const TWO_LEGGED: GcpAuthProviderScheme = {
  type: 'gcpAuthProviderScheme',
  name: 'projects/p/locations/l/authProviders/spotify-2lo',
};

const THREE_LEGGED: GcpAuthProviderScheme = {
  type: 'gcpAuthProviderScheme',
  name: 'projects/p/locations/l/authProviders/spotify-3lo',
  scopes: ['user-read-private'],
  continueUri: 'https://my-agent.example.com/auth/continue',
};

describe('GcpAuthProviderScheme', () => {
  it('serialises a two-legged scheme as type and name only', () => {
    const roundTripped: unknown = JSON.parse(JSON.stringify(TWO_LEGGED));

    expect(roundTripped).toEqual({
      type: 'gcpAuthProviderScheme',
      name: 'projects/p/locations/l/authProviders/spotify-2lo',
    });
  });

  it('serialises a three-legged scheme with camelCase wire names', () => {
    const roundTripped: unknown = JSON.parse(JSON.stringify(THREE_LEGGED));

    expect(Object.keys(roundTripped as object)).toEqual([
      'type',
      'name',
      'scopes',
      'continueUri',
    ]);
    expect(roundTripped).toEqual({
      type: 'gcpAuthProviderScheme',
      name: 'projects/p/locations/l/authProviders/spotify-3lo',
      scopes: ['user-read-private'],
      continueUri: 'https://my-agent.example.com/auth/continue',
    });
  });

  it('extends CustomAuthScheme and is a member of AuthScheme', () => {
    expectTypeOf<GcpAuthProviderScheme>().toExtend<CustomAuthScheme>();
    expectTypeOf<GcpAuthProviderScheme>().toExtend<AuthScheme>();
  });

  it('goes into an AuthConfig without a cast', () => {
    const config: AuthConfig = {
      authScheme: THREE_LEGGED,
      credentialKey: 'spotify',
    };

    expect(config.authScheme).toBe(THREE_LEGGED);
  });

  it('rejects a scheme that omits name or renames the type literal', () => {
    expectTypeOf<{
      type: 'gcpAuthProviderScheme';
    }>().not.toExtend<GcpAuthProviderScheme>();
    expectTypeOf<{
      type: 'gcpAuthProvider';
      name: string;
    }>().not.toExtend<GcpAuthProviderScheme>();
  });

  it('is the same declaration the agent_registry path re-exports', () => {
    expectTypeOf<SchemeFromAgentRegistry>().toEqualTypeOf<GcpAuthProviderScheme>();
  });
});
