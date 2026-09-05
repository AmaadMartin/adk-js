/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Behaviour of GCPSkillRegistry that the adk-python reference suite does not
 * cover: unresolved configuration, the endpoint override on both calls, and
 * the transport failure paths.
 */

import {GCPSkillRegistry} from '@google/adk';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {logger} from '../../src/utils/logger.js';
import {
  DEFAULT_BASE_URL,
  FetchInit,
  RESOURCE_PARENT,
  TEST_LOCATION,
  TEST_PROJECT,
  bytesResponse,
  createSkillZip,
  credentialsFor,
  jsonResponse,
} from './gcp_skill_registry_test_utils.js';

const {googleAuthMock, getClientMock, clientCertsToPresentMock} = vi.hoisted(
  () => ({
    googleAuthMock: vi.fn(),
    getClientMock: vi.fn(),
    clientCertsToPresentMock: vi.fn(),
  }),
);

vi.mock('google-auth-library', async (importOriginal) => ({
  ...(await importOriginal<typeof import('google-auth-library')>()),
  GoogleAuth: googleAuthMock,
}));

vi.mock('../../src/utils/mtls_utils.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/utils/mtls_utils.js')>()),
  clientCertsToPresent: clientCertsToPresentMock,
}));

const REVISION = `${RESOURCE_PARENT}/skills/my-skill/revisions/rev-123`;

const fetchMock = vi.fn<(url: string, init?: FetchInit) => Promise<Response>>();

/** Returns the headers the registry sent on its `nth` request. */
function sentHeaders(nth: number): Record<string, string> {
  return fetchMock.mock.calls[nth][1]?.headers as Record<string, string>;
}

describe('GCPSkillRegistry', () => {
  beforeEach(() => {
    vi.stubEnv('GOOGLE_CLOUD_PROJECT', TEST_PROJECT);
    vi.stubEnv('GOOGLE_CLOUD_LOCATION', TEST_LOCATION);
    vi.stubEnv('AGENT_REGISTRY_ENDPOINT', undefined);
    vi.stubEnv('GOOGLE_API_USE_CLIENT_CERTIFICATE', undefined);
    vi.stubEnv('GOOGLE_API_USE_MTLS_ENDPOINT', undefined);
    vi.stubGlobal('fetch', fetchMock);

    fetchMock.mockReset();
    googleAuthMock.mockReset();
    getClientMock.mockReset();
    googleAuthMock.mockImplementation(() => ({getClient: getClientMock}));
    getClientMock.mockResolvedValue(credentialsFor('fake-token'));
    clientCertsToPresentMock.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
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

    it('prefers the options over the environment', () => {
      const registry = new GCPSkillRegistry({
        projectId: 'option-project',
        location: 'europe-west1',
      });

      expect(registry.projectId).toBe('option-project');
      expect(registry.location).toBe('europe-west1');
    });

    it('sends both calls of a fetch to the endpoint override', async () => {
      vi.stubEnv('AGENT_REGISTRY_ENDPOINT', 'https://staging.endpoint.com');
      fetchMock.mockImplementation((url) =>
        Promise.resolve(
          url.includes('alt=media')
            ? bytesResponse(createSkillZip())
            : jsonResponse({defaultRevision: REVISION}),
        ),
      );

      const skill = await new GCPSkillRegistry().getSkill('my-skill');

      expect(fetchMock.mock.calls[0][0]).toBe(
        `https://staging.endpoint.com/${RESOURCE_PARENT}/skills/my-skill`,
      );
      expect(fetchMock.mock.calls[1][0]).toBe(
        `https://staging.endpoint.com/${REVISION}?alt=media`,
      );
      expect(skill.uri).toBe(`https://staging.endpoint.com/${REVISION}`);
    });

    it('reads the revision from the snake_case field', async () => {
      fetchMock.mockImplementation((url) =>
        Promise.resolve(
          url.includes('alt=media')
            ? bytesResponse(createSkillZip())
            : jsonResponse({default_revision: REVISION}),
        ),
      );

      const skill = await new GCPSkillRegistry().getSkill('my-skill');

      expect(skill.uri).toBe(`${DEFAULT_BASE_URL}/${REVISION}`);
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
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('bills the project when the credentials carry no quota project', async () => {
      fetchMock.mockResolvedValue(jsonResponse({skills: []}));

      await new GCPSkillRegistry().searchSkills('query');

      expect(sentHeaders(0)['x-goog-user-project']).toBe(TEST_PROJECT);
    });

    it('resolves the credentials once for the two calls of a fetch', async () => {
      fetchMock.mockImplementation((url) =>
        Promise.resolve(
          url.includes('alt=media')
            ? bytesResponse(createSkillZip())
            : jsonResponse({defaultRevision: REVISION}),
        ),
      );

      await new GCPSkillRegistry().getSkill('my-skill');

      expect(getClientMock).toHaveBeenCalledTimes(1);
    });
  });

  describe('transport failures', () => {
    it('reports the status and the body of a non-2xx response', async () => {
      fetchMock.mockResolvedValue(
        new Response('skill not found', {status: 404}),
      );

      await expect(new GCPSkillRegistry().getSkill('my-skill')).rejects.toThrow(
        'API request failed with status 404: skill not found',
      );
    });

    it('reports a transport error that carries no status', async () => {
      fetchMock.mockRejectedValue(new Error('getaddrinfo ENOTFOUND'));

      await expect(
        new GCPSkillRegistry().searchSkills('query'),
      ).rejects.toThrow('API request failed: getaddrinfo ENOTFOUND');
    });
  });

  describe('searchSkills', () => {
    it('returns nothing for a response that carries no skills array', async () => {
      fetchMock.mockResolvedValue(jsonResponse({}));

      await expect(
        new GCPSkillRegistry().searchSkills('query'),
      ).resolves.toEqual([]);
    });

    it('skips a hit that is not an object at all', async () => {
      const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
      fetchMock.mockResolvedValue(
        jsonResponse({
          skills: [
            'projects/p/locations/l/skills/skill1',
            {name: `${RESOURCE_PARENT}/skills/skill2`, description: 'kept'},
          ],
        }),
      );

      const results = await new GCPSkillRegistry().searchSkills('query');

      expect(results.map((hit) => hit.name)).toEqual(['skill2']);
      expect(warn).toHaveBeenCalledTimes(1);
    });

    it('encodes a query that carries URL punctuation', async () => {
      fetchMock.mockResolvedValue(jsonResponse({skills: []}));

      await new GCPSkillRegistry().searchSkills('a&b=c d');

      expect(fetchMock.mock.calls[0][0]).toBe(
        `${DEFAULT_BASE_URL}/${RESOURCE_PARENT}` +
          '/skills:search?search_string=a%26b%3Dc+d',
      );
    });
  });
});
