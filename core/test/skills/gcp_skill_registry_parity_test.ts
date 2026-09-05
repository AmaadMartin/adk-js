/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Tests ported from google/adk-python, branch `main`, file
 * `tests/unittests/integrations/skill_registry/test_gcp_skill_registry.py`.
 *
 * Every `it` title is the Python test function name, verbatim, so the two
 * suites can be compared name by name.
 */

import {GCPSkillRegistry} from '@google/adk';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {mergeTrackingHeaders} from '../../src/utils/client_labels.js';
import {logger} from '../../src/utils/logger.js';
import type {MtlsClientCerts} from '../../src/utils/mtls_utils.js';
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

const {
  googleAuthMock,
  getClientMock,
  clientCertsToPresentMock,
  getBytesWithClientCertMock,
} = vi.hoisted(() => ({
  googleAuthMock: vi.fn(),
  getClientMock: vi.fn(),
  clientCertsToPresentMock: vi.fn(),
  getBytesWithClientCertMock: vi.fn(),
}));

vi.mock('google-auth-library', async (importOriginal) => ({
  ...(await importOriginal<typeof import('google-auth-library')>()),
  GoogleAuth: googleAuthMock,
}));

vi.mock('../../src/utils/mtls_utils.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/utils/mtls_utils.js')>()),
  clientCertsToPresent: clientCertsToPresentMock,
  getBytesWithClientCert: getBytesWithClientCertMock,
}));

const REVISION = `${RESOURCE_PARENT}/skills/my-skill/revisions/rev-123`;
const SKILL_URL = `${DEFAULT_BASE_URL}/${RESOURCE_PARENT}/skills/my-skill`;
const REVISION_URL = `${DEFAULT_BASE_URL}/${REVISION}`;
const SEARCH_URL = `${DEFAULT_BASE_URL}/${RESOURCE_PARENT}/skills:search`;

const fetchMock = vi.fn<(url: string, init?: FetchInit) => Promise<Response>>();

/** The headers the registry is expected to put on the wire. */
function expectedHeaders(
  token: string,
  quotaProject: string,
): Record<string, string> {
  return mergeTrackingHeaders({
    'Authorization': `Bearer ${token}`,
    'Content-Type': 'application/json',
    'x-goog-user-project': quotaProject,
  });
}

/** Returns the headers the registry sent on its `nth` request. */
function sentHeaders(nth: number): unknown {
  return fetchMock.mock.calls[nth][1]?.headers;
}

/** Answers the metadata call with `skillData`, and the media call with `zip`. */
function serve(skillData: unknown, zip = createSkillZip()): void {
  fetchMock.mockImplementation((url) =>
    Promise.resolve(
      url.includes('alt=media') ? bytesResponse(zip) : jsonResponse(skillData),
    ),
  );
}

describe('GCPSkillRegistry parity', () => {
  beforeEach(() => {
    vi.stubEnv('GOOGLE_CLOUD_PROJECT', TEST_PROJECT);
    vi.stubEnv('GOOGLE_CLOUD_LOCATION', TEST_LOCATION);
    vi.stubEnv('AGENT_REGISTRY_ENDPOINT', undefined);
    vi.stubEnv('GOOGLE_API_USE_CLIENT_CERTIFICATE', undefined);
    vi.stubEnv('GOOGLE_API_USE_MTLS_ENDPOINT', undefined);
    vi.stubGlobal('fetch', fetchMock);

    fetchMock.mockReset();
    getBytesWithClientCertMock.mockReset();
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

  it('test_get_skill_success', async () => {
    serve({name: SKILL_URL, defaultRevision: REVISION});

    const skill = await new GCPSkillRegistry().getSkill('my-skill');

    expect(skill.frontmatter.name).toBe('my-skill');
    expect(skill.frontmatter.description).toBe('test');
    expect(skill.instructions).toBe('# My Skill');
    expect(skill.uri).toBe(REVISION_URL);

    expect(fetchMock.mock.calls[0][0]).toBe(SKILL_URL);
    expect(sentHeaders(0)).toEqual(expectedHeaders('fake-token', TEST_PROJECT));
    expect(fetchMock.mock.calls[1][0]).toBe(`${REVISION_URL}?alt=media`);
    expect(sentHeaders(1)).toEqual(expectedHeaders('fake-token', TEST_PROJECT));
  });

  it('test_search_skills_success', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        skills: [
          {
            name: `${RESOURCE_PARENT}/skills/skill1`,
            description: 'Description 1',
          },
          {
            name: `${RESOURCE_PARENT}/skills/skill2`,
            description: 'Description 2',
          },
        ],
      }),
    );

    const results = await new GCPSkillRegistry().searchSkills('query');

    expect(results).toEqual([
      expect.objectContaining({name: 'skill1', description: 'Description 1'}),
      expect.objectContaining({name: 'skill2', description: 'Description 2'}),
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe(
      `${SEARCH_URL}?search_string=query`,
    );
    expect(sentHeaders(0)).toEqual(expectedHeaders('fake-token', TEST_PROJECT));
  });

  it.each([
    // A real first-party catalog entry: dots are outside the name pattern.
    ['cloud.google.com-agent-platform-eval-flywheel', 'Description bad'],
    ['Skill-With-Caps', 'Description bad'],
    ['a'.repeat(65), 'Description bad'],
    ['skill-no-description', ''],
  ])(
    'test_search_skills_skips_entry_failing_validation [%s]',
    async (badName, badDescription) => {
      const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
      fetchMock.mockResolvedValue(
        jsonResponse({
          skills: [
            {
              name: `${RESOURCE_PARENT}/skills/${badName}`,
              description: badDescription,
            },
            {
              name: `${RESOURCE_PARENT}/skills/skill2`,
              description: 'Description 2',
            },
          ],
        }),
      );

      const results = await new GCPSkillRegistry().searchSkills('query');

      expect(results.map((r) => r.name)).toEqual(['skill2']);
      expect(results[0].description).toBe('Description 2');
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0][0]).toContain(badName);
    },
  );

  it.each([[null], [7], [['a']]])(
    'test_search_skills_skips_entry_whose_name_is_not_a_string [%j]',
    async (rawName) => {
      const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
      fetchMock.mockResolvedValue(
        jsonResponse({
          skills: [
            {name: rawName, description: 'Description 1'},
            {
              name: `${RESOURCE_PARENT}/skills/skill2`,
              description: 'Description 2',
            },
          ],
        }),
      );

      const results = await new GCPSkillRegistry().searchSkills('query');

      expect(results.map((r) => r.name)).toEqual(['skill2']);
      expect(warn).toHaveBeenCalledTimes(1);
    },
  );

  it('test_registry_requests_identify_adk', async () => {
    fetchMock.mockResolvedValue(jsonResponse({skills: []}));

    await new GCPSkillRegistry().searchSkills('query');

    const headers = sentHeaders(0) as Record<string, string>;
    expect(headers['x-goog-api-client']).toContain('google-adk/');
    expect(headers['user-agent']).toContain('google-adk/');
  });

  it('test_get_skill_raises_on_missing_zip', async () => {
    serve({name: SKILL_URL});

    await expect(new GCPSkillRegistry().getSkill('my-skill')).rejects.toThrow(
      "Skill 'my-skill' does not contain default revision.",
    );
  });

  it('test_get_skill_raises_on_zip_slip', async () => {
    serve(
      {name: SKILL_URL, defaultRevision: REVISION},
      createSkillZip(undefined, '../evil.txt'),
    );

    await expect(new GCPSkillRegistry().getSkill('my-skill')).rejects.toThrow(
      'Dangerous zip entry ignored: ../evil.txt',
    );
  });

  it('test_get_skill_raises_on_invalid_skill_name', async () => {
    serve(
      {name: SKILL_URL, defaultRevision: REVISION},
      createSkillZip(
        '---\nname: ../evil\ndescription: test\n---\n# My Skill\n',
      ),
    );

    await expect(new GCPSkillRegistry().getSkill('my-skill')).rejects.toThrow(
      'Invalid skill name in SKILL.md',
    );
  });

  it.each([
    '../../../projects/victim/locations/us-central1/skills/secret',
    'my-skill/../other-skill',
    '..%2f..%2fsecret',
    'my-skill?alt=media',
    'my-skill#fragment',
    'my-skill/revisions/rev-123',
    'My-Skill',
    '',
  ])(
    'test_get_skill_rejects_unsafe_name_before_any_request [%j]',
    async (unsafeName) => {
      await expect(new GCPSkillRegistry().getSkill(unsafeName)).rejects.toThrow(
        'Invalid skill name',
      );
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );

  it.each(['my-skill', 'my_skill', 'skill2'])(
    'test_get_skill_builds_expected_url_for_valid_name [%s]',
    async (validName) => {
      const revision = `${RESOURCE_PARENT}/skills/${validName}/revisions/rev-123`;
      serve({
        name: `${RESOURCE_PARENT}/skills/${validName}`,
        defaultRevision: revision,
      });

      await new GCPSkillRegistry().getSkill(validName);

      expect(fetchMock.mock.calls[0][0]).toBe(
        `${DEFAULT_BASE_URL}/${RESOURCE_PARENT}/skills/${validName}`,
      );
    },
  );

  it('test_constructor_configures_base_url', () => {
    vi.stubEnv('AGENT_REGISTRY_ENDPOINT', 'https://staging.endpoint.com');
    expect(new GCPSkillRegistry().baseUrl).toBe('https://staging.endpoint.com');

    vi.stubEnv('AGENT_REGISTRY_ENDPOINT', undefined);
    expect(new GCPSkillRegistry().baseUrl).toBe(DEFAULT_BASE_URL);
  });

  it('test_lazy_load_credentials', () => {
    const registry = new GCPSkillRegistry();

    expect(registry.baseUrl).toBe(DEFAULT_BASE_URL);
    expect(googleAuthMock).not.toHaveBeenCalled();
    expect(getClientMock).not.toHaveBeenCalled();
    expect(clientCertsToPresentMock).not.toHaveBeenCalled();
  });

  it('test_constructor_configures_mtls_base_url', () => {
    vi.stubEnv('GOOGLE_API_USE_CLIENT_CERTIFICATE', 'true');

    expect(new GCPSkillRegistry().baseUrl).toBe(
      'https://agentregistry.mtls.googleapis.com/v1alpha',
    );
  });

  it('test_get_skill_with_mtls', async () => {
    const certs: MtlsClientCerts = {cert: 'fake-cert', key: 'fake-key'};
    const mtlsRevision = `${RESOURCE_PARENT}/skills/my-skill/revisions/rev-123`;
    const mtlsBase = 'https://agentregistry.mtls.googleapis.com/v1alpha';
    vi.stubEnv('GOOGLE_API_USE_CLIENT_CERTIFICATE', 'true');
    clientCertsToPresentMock.mockResolvedValue(certs);
    getBytesWithClientCertMock.mockImplementation((url: string) =>
      Promise.resolve(
        url.includes('alt=media')
          ? {status: 200, body: createSkillZip()}
          : {
              status: 200,
              body: Buffer.from(
                JSON.stringify({defaultRevision: mtlsRevision}),
                'utf-8',
              ),
            },
      ),
    );

    const skill = await new GCPSkillRegistry().getSkill('my-skill');

    expect(skill.frontmatter.name).toBe('my-skill');
    expect(fetchMock).not.toHaveBeenCalled();
    expect(getBytesWithClientCertMock).toHaveBeenCalledTimes(2);
    expect(getBytesWithClientCertMock.mock.calls[0][0]).toBe(
      `${mtlsBase}/${RESOURCE_PARENT}/skills/my-skill`,
    );
    expect(getBytesWithClientCertMock.mock.calls[0][2]).toBe(certs);
    expect(getBytesWithClientCertMock.mock.calls[1][2]).toBe(certs);
    // The certificate provider is a child process, so it runs once per
    // registry however many requests the call makes.
    expect(clientCertsToPresentMock).toHaveBeenCalledTimes(1);
  });

  it('test_use_custom_credentials', async () => {
    fetchMock.mockResolvedValue(jsonResponse({skills: []}));

    await new GCPSkillRegistry({
      credentials: credentialsFor('custom-token', 'custom-quota-project'),
    }).searchSkills('query');

    expect(getClientMock).not.toHaveBeenCalled();
    expect(fetchMock.mock.calls[0][0]).toBe(
      `${SEARCH_URL}?search_string=query`,
    );
    expect(sentHeaders(0)).toEqual(
      expectedHeaders('custom-token', 'custom-quota-project'),
    );
  });
});
