/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Behaviour of GCPSkillRegistry that the adk-python reference suite does not
 * cover: unresolved configuration, the endpoint override on both calls, the
 * transport failure paths, and what actually reaches the wire.
 */

import {GCPSkillRegistry} from '@google/adk';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {getTrackingHeaders} from '../../src/utils/client_labels.js';
import {logger} from '../../src/utils/logger.js';
import {
  DEFAULT_BASE_URL,
  RESOURCE_PARENT,
  RegistryServer,
  Responder,
  TEST_LOCATION,
  TEST_PROJECT,
  createSkillZip,
  createTempHome,
  credentialsFor,
  jsonBody,
  startRegistryServer,
  stubTransport,
} from './gcp_skill_registry_test_utils.js';

const {googleAuthMock, getClientMock, clientCertsToPresentMock, homedirMock} =
  vi.hoisted(() => ({
    googleAuthMock: vi.fn(),
    getClientMock: vi.fn(),
    clientCertsToPresentMock: vi.fn(),
    homedirMock: vi.fn(),
  }));

// The endpoint choice reads this machine's SecureConnect metadata, so the
// tests own the home directory it looks in. Reading the real one would pass on
// a workstation that has a certificate and fail on a runner that does not.
vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof os>();
  return {
    ...actual,
    default: {...actual, homedir: homedirMock},
    homedir: homedirMock,
  };
});

vi.mock('google-auth-library', async (importOriginal) => ({
  ...(await importOriginal<typeof import('google-auth-library')>()),
  GoogleAuth: googleAuthMock,
}));

vi.mock('../../src/utils/mtls_utils.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/utils/mtls_utils.js')>()),
  clientCertsToPresent: clientCertsToPresentMock,
}));

const REVISION = `${RESOURCE_PARENT}/skills/my-skill/revisions/rev-123`;

/** Answers the metadata call with `skillData`, and the media call with a zip. */
function skillResponder(skillData: unknown): Responder {
  return (url) =>
    url.includes('alt=media')
      ? {body: createSkillZip()}
      : {body: jsonBody(skillData)};
}

describe('GCPSkillRegistry', () => {
  let credentials = credentialsFor('fake-token');
  let homeDir: string;

  beforeEach(async () => {
    homeDir = await createTempHome();
    homedirMock.mockReturnValue(homeDir);

    vi.stubEnv('GOOGLE_CLOUD_PROJECT', TEST_PROJECT);
    vi.stubEnv('GOOGLE_CLOUD_LOCATION', TEST_LOCATION);
    vi.stubEnv('AGENT_REGISTRY_ENDPOINT', undefined);
    vi.stubEnv('GOOGLE_API_USE_CLIENT_CERTIFICATE', undefined);
    vi.stubEnv('GOOGLE_API_USE_MTLS_ENDPOINT', undefined);

    credentials = credentialsFor('fake-token');
    googleAuthMock.mockReset();
    getClientMock.mockReset();
    googleAuthMock.mockImplementation(() => ({getClient: getClientMock}));
    getClientMock.mockResolvedValue(credentials);
    clientCertsToPresentMock.mockResolvedValue(undefined);
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    await fs.rm(homeDir, {recursive: true, force: true});
  });

  describe('configuration', () => {
    it('throws when neither the options nor the environment name a project', () => {
      vi.stubEnv('GOOGLE_CLOUD_PROJECT', undefined);

      expect(() => new GCPSkillRegistry()).toThrow(
        'project_id and location must be specified or set via environment' +
          ' variables.',
      );
    });

    it('throws when neither the options nor the environment name a location', () => {
      vi.stubEnv('GOOGLE_CLOUD_LOCATION', undefined);

      expect(() => new GCPSkillRegistry()).toThrow(
        'project_id and location must be specified or set via environment' +
          ' variables.',
      );
    });

    it('prefers the options over the environment', async () => {
      const transport = stubTransport(
        credentials,
        skillResponder({defaultRevision: REVISION}),
      );

      await new GCPSkillRegistry({
        projectId: 'option-project',
        location: 'europe-west1',
      }).getSkill('my-skill');

      expect(transport.calls[0].url).toBe(
        `${DEFAULT_BASE_URL}/projects/option-project/locations/europe-west1` +
          '/skills/my-skill',
      );
    });

    it('stays on the default host when the machine has no certificate to present', async () => {
      vi.stubEnv('GOOGLE_API_USE_CLIENT_CERTIFICATE', 'true');
      const transport = stubTransport(
        credentials,
        skillResponder({defaultRevision: REVISION}),
      );

      await new GCPSkillRegistry().getSkill('my-skill');

      expect(transport.calls[0].url).toBe(
        `${DEFAULT_BASE_URL}/${RESOURCE_PARENT}/skills/my-skill`,
      );
    });

    it('sends both calls of a fetch to the endpoint override', async () => {
      vi.stubEnv('AGENT_REGISTRY_ENDPOINT', 'https://staging.endpoint.com');
      const transport = stubTransport(
        credentials,
        skillResponder({defaultRevision: REVISION}),
      );

      await new GCPSkillRegistry().getSkill('my-skill');

      expect(transport.calls.map((call) => call.url)).toEqual([
        `https://staging.endpoint.com/${RESOURCE_PARENT}/skills/my-skill`,
        `https://staging.endpoint.com/${REVISION}?alt=media`,
      ]);
    });

    it('reads the revision from the snake_case field', async () => {
      const transport = stubTransport(
        credentials,
        skillResponder({default_revision: REVISION}),
      );

      await new GCPSkillRegistry().getSkill('my-skill');

      expect(transport.calls[1].url).toBe(
        `${DEFAULT_BASE_URL}/${REVISION}?alt=media`,
      );
    });
  });

  describe('credentials', () => {
    it('reports a failure to resolve application default credentials', async () => {
      getClientMock.mockRejectedValue(new Error('no ADC on this machine'));

      await expect(
        new GCPSkillRegistry().searchSkills('query'),
      ).rejects.toThrow(
        'Failed to get default Google Cloud credentials: no ADC on this' +
          ' machine',
      );
    });

    it('resolves the credentials once for the two calls of a fetch', async () => {
      stubTransport(credentials, skillResponder({defaultRevision: REVISION}));

      await new GCPSkillRegistry().getSkill('my-skill');

      expect(getClientMock).toHaveBeenCalledTimes(1);
    });
  });

  describe('transport failures', () => {
    it('reports the status and the body of a non-2xx response', async () => {
      stubTransport(credentials, () => ({
        status: 404,
        body: Buffer.from('skill not found', 'utf-8'),
      }));

      await expect(new GCPSkillRegistry().getSkill('my-skill')).rejects.toThrow(
        'API request failed with status 404: skill not found',
      );
    });

    it('reports a transport error that carries no status', async () => {
      vi.spyOn(credentials, 'request').mockRejectedValue(
        new Error('getaddrinfo ENOTFOUND'),
      );

      await expect(
        new GCPSkillRegistry().searchSkills('query'),
      ).rejects.toThrow('API request failed: getaddrinfo ENOTFOUND');
    });
  });

  describe('searchSkills', () => {
    it('returns nothing for a response that carries no skills array', async () => {
      stubTransport(credentials, () => ({body: jsonBody({})}));

      await expect(
        new GCPSkillRegistry().searchSkills('query'),
      ).resolves.toEqual([]);
    });

    it('skips a hit that is not an object at all', async () => {
      const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
      stubTransport(credentials, () => ({
        body: jsonBody({
          skills: [
            'projects/p/locations/l/skills/skill1',
            {name: `${RESOURCE_PARENT}/skills/skill2`, description: 'kept'},
          ],
        }),
      }));

      const results = await new GCPSkillRegistry().searchSkills('query');

      expect(results.map((hit) => hit.name)).toEqual(['skill2']);
      expect(warn).toHaveBeenCalledTimes(1);
    });

    it('encodes a query that carries URL punctuation', async () => {
      const transport = stubTransport(credentials, () => ({
        body: jsonBody({skills: []}),
      }));

      await new GCPSkillRegistry().searchSkills('a&b=c d');

      expect(transport.calls[0].url).toBe(
        `${DEFAULT_BASE_URL}/${RESOURCE_PARENT}` +
          '/skills:search?search_string=a%26b%3Dc+d',
      );
    });
  });

  // These drive a real HTTP server and real credentials, with nothing mocked
  // below the registry, so they show what a request actually carries. The
  // bearer token is the point: the credentials add it, not the registry, so no
  // assertion on the registry's own headers can prove it was sent.
  describe('against a real server', () => {
    let server: RegistryServer;

    afterEach(async () => {
      await server.close();
    });

    /** Starts the server and points the registry at it. */
    async function serveOn(respond: Responder): Promise<void> {
      server = await startRegistryServer(respond);
      vi.stubEnv('AGENT_REGISTRY_ENDPOINT', server.baseUrl);
    }

    it('loads a skill over two requests that carry the bearer token', async () => {
      await serveOn(skillResponder({defaultRevision: REVISION}));

      const skill = await new GCPSkillRegistry().getSkill('my-skill');

      expect(skill.frontmatter.name).toBe('my-skill');
      expect(server.requests.map((request) => request.url)).toEqual([
        `/${RESOURCE_PARENT}/skills/my-skill`,
        `/${REVISION}?alt=media`,
      ]);
      for (const request of server.requests) {
        expect(request.headers.authorization).toBe('Bearer fake-token');
        expect(request.headers['x-goog-user-project']).toBe(TEST_PROJECT);
        expect(request.headers['x-goog-api-client']).toBe(
          getTrackingHeaders()['x-goog-api-client'],
        );
        expect(request.headers['user-agent']).toContain('google-adk/');
      }
    });

    it('bills the quota project the credentials name', async () => {
      await serveOn(() => ({body: jsonBody({skills: []})}));

      await new GCPSkillRegistry({
        credentials: credentialsFor('custom-token', 'custom-quota-project'),
      }).searchSkills('query');

      expect(server.requests[0].headers.authorization).toBe(
        'Bearer custom-token',
      );
      expect(server.requests[0].headers['x-goog-user-project']).toBe(
        'custom-quota-project',
      );
    });

    it('reports the body of a non-2xx response the server sent', async () => {
      await serveOn(() => ({
        status: 403,
        body: Buffer.from('caller has no access', 'utf-8'),
      }));

      await expect(
        new GCPSkillRegistry().searchSkills('query'),
      ).rejects.toThrow(
        'API request failed with status 403: caller has no access',
      );
    });
  });
});
