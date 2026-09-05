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
 *
 * The reference mocks `httpx.AsyncClient.get` and asserts the headers passed
 * to it, `Authorization` among them. Here the credentials own the transport
 * and add that header themselves, so the assertions below cover the headers
 * the registry sets, and `gcp_skill_registry_test.ts` proves the bearer token
 * on the wire against a real server.
 */

import {GCPSkillRegistry} from '@google/adk';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {getTrackingHeaders} from '../../src/utils/client_labels.js';
import {logger} from '../../src/utils/logger.js';
import type {MtlsClientCerts} from '../../src/utils/mtls_utils.js';
import {
  DEFAULT_BASE_URL,
  RESOURCE_PARENT,
  RecordedTransport,
  RequestOptions,
  Responder,
  TEST_LOCATION,
  TEST_PROJECT,
  createSkillZip,
  createTempHome,
  credentialsFor,
  jsonBody,
  stubTransport,
  writeCertSource,
} from './gcp_skill_registry_test_utils.js';

const {googleAuthMock, getClientMock, clientCertsToPresentMock, homedirMock} =
  vi.hoisted(() => ({
    googleAuthMock: vi.fn(),
    getClientMock: vi.fn(),
    clientCertsToPresentMock: vi.fn(),
    homedirMock: vi.fn(),
  }));

// The endpoint choice asks whether this machine has a SecureConnect
// certificate, so the tests own the home directory it looks in. Reading the
// real one would pass on a workstation that has one and fail on a CI runner.
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
const SKILL_URL = `${DEFAULT_BASE_URL}/${RESOURCE_PARENT}/skills/my-skill`;
const REVISION_URL = `${DEFAULT_BASE_URL}/${REVISION}`;
const SEARCH_URL = `${DEFAULT_BASE_URL}/${RESOURCE_PARENT}/skills:search`;

/** The credentials the registry resolves when the test passes none. */
let credentials = credentialsFor('fake-token');

/** Installs `respond` on those credentials and records what they were asked. */
function serve(respond: Responder): RecordedTransport {
  return stubTransport(credentials, respond);
}

/** Answers the metadata call with `skillData`, and the media call with `zip`. */
function serveSkill(
  skillData: unknown,
  zip = createSkillZip(),
): RecordedTransport {
  return serve((url) =>
    url.includes('alt=media') ? {body: zip} : {body: jsonBody(skillData)},
  );
}

/** Fetches a skill and reports the URL of the first request it made. */
async function firstRequestUrl(): Promise<RequestOptions['url']> {
  const transport = serveSkill({defaultRevision: REVISION});
  await new GCPSkillRegistry().getSkill('my-skill');
  return transport.calls[0].url;
}

/** The headers the registry sets on every call, besides the bearer token. */
function expectedHeaders(quotaProject: string): Record<string, string> {
  return {
    ...getTrackingHeaders(),
    'Content-Type': 'application/json',
    'x-goog-user-project': quotaProject,
  };
}

describe('GCPSkillRegistry parity', () => {
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

  it('test_get_skill_success', async () => {
    const transport = serveSkill({name: SKILL_URL, defaultRevision: REVISION});

    const skill = await new GCPSkillRegistry().getSkill('my-skill');

    expect(skill.frontmatter.name).toBe('my-skill');
    expect(skill.frontmatter.description).toBe('test');
    expect(skill.instructions).toBe('# My Skill');

    expect(transport.calls[0].url).toBe(SKILL_URL);
    expect(transport.calls[0].headers).toEqual(expectedHeaders(TEST_PROJECT));
    expect(transport.calls[1].url).toBe(`${REVISION_URL}?alt=media`);
    expect(transport.calls[1].headers).toEqual(expectedHeaders(TEST_PROJECT));
  });

  it('test_search_skills_success', async () => {
    const transport = serve(() => ({
      body: jsonBody({
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
    }));

    const results = await new GCPSkillRegistry().searchSkills('query');

    expect(results).toEqual([
      expect.objectContaining({name: 'skill1', description: 'Description 1'}),
      expect.objectContaining({name: 'skill2', description: 'Description 2'}),
    ]);
    expect(transport.calls).toHaveLength(1);
    expect(transport.calls[0].url).toBe(`${SEARCH_URL}?search_string=query`);
    expect(transport.calls[0].headers).toEqual(expectedHeaders(TEST_PROJECT));
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
      serve(() => ({
        body: jsonBody({
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
      }));

      const results = await new GCPSkillRegistry().searchSkills('query');

      expect(results.map((hit) => hit.name)).toEqual(['skill2']);
      expect(results[0].description).toBe('Description 2');
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0][0]).toContain(badName);
    },
  );

  it.each([[null], [7], [['a']]])(
    'test_search_skills_skips_entry_whose_name_is_not_a_string [%j]',
    async (rawName) => {
      const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
      serve(() => ({
        body: jsonBody({
          skills: [
            {name: rawName, description: 'Description 1'},
            {
              name: `${RESOURCE_PARENT}/skills/skill2`,
              description: 'Description 2',
            },
          ],
        }),
      }));

      const results = await new GCPSkillRegistry().searchSkills('query');

      expect(results.map((hit) => hit.name)).toEqual(['skill2']);
      expect(warn).toHaveBeenCalledTimes(1);
    },
  );

  it('test_registry_requests_identify_adk', async () => {
    const transport = serve(() => ({body: jsonBody({skills: []})}));

    await new GCPSkillRegistry().searchSkills('query');

    expect(transport.calls[0].headers).toMatchObject({
      'x-goog-api-client': expect.stringContaining('google-adk/'),
      'user-agent': expect.stringContaining('google-adk/'),
    });
  });

  it('test_get_skill_raises_on_missing_zip', async () => {
    serveSkill({name: SKILL_URL});

    await expect(new GCPSkillRegistry().getSkill('my-skill')).rejects.toThrow(
      "Skill 'my-skill' does not contain default revision.",
    );
  });

  it('test_get_skill_raises_on_zip_slip', async () => {
    serveSkill(
      {name: SKILL_URL, defaultRevision: REVISION},
      createSkillZip(undefined, '../evil.txt'),
    );

    await expect(new GCPSkillRegistry().getSkill('my-skill')).rejects.toThrow(
      'Dangerous zip entry ignored: ../evil.txt',
    );
  });

  it('test_get_skill_raises_on_invalid_skill_name', async () => {
    serveSkill(
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
      const transport = serveSkill({defaultRevision: REVISION});

      await expect(new GCPSkillRegistry().getSkill(unsafeName)).rejects.toThrow(
        'Invalid skill name',
      );
      expect(transport.calls).toHaveLength(0);
    },
  );

  it.each(['my-skill', 'my_skill', 'skill2'])(
    'test_get_skill_builds_expected_url_for_valid_name [%s]',
    async (validName) => {
      const transport = serveSkill({
        name: `${RESOURCE_PARENT}/skills/${validName}`,
        defaultRevision: `${RESOURCE_PARENT}/skills/${validName}/revisions/rev-123`,
      });

      await new GCPSkillRegistry().getSkill(validName);

      expect(transport.calls[0].url).toBe(
        `${DEFAULT_BASE_URL}/${RESOURCE_PARENT}/skills/${validName}`,
      );
    },
  );

  it('test_constructor_configures_base_url', async () => {
    vi.stubEnv('AGENT_REGISTRY_ENDPOINT', 'https://staging.endpoint.com');
    expect(await firstRequestUrl()).toBe(
      `https://staging.endpoint.com/${RESOURCE_PARENT}/skills/my-skill`,
    );

    vi.stubEnv('AGENT_REGISTRY_ENDPOINT', undefined);
    expect(await firstRequestUrl()).toBe(SKILL_URL);
  });

  it('test_lazy_load_credentials', () => {
    new GCPSkillRegistry();

    expect(googleAuthMock).not.toHaveBeenCalled();
    expect(getClientMock).not.toHaveBeenCalled();
    expect(clientCertsToPresentMock).not.toHaveBeenCalled();
  });

  it('test_constructor_configures_mtls_base_url', async () => {
    await writeCertSource(homeDir);
    vi.stubEnv('GOOGLE_API_USE_CLIENT_CERTIFICATE', 'true');

    expect(await firstRequestUrl()).toBe(
      'https://agentregistry.mtls.googleapis.com/v1alpha' +
        `/${RESOURCE_PARENT}/skills/my-skill`,
    );
  });

  it('test_get_skill_with_mtls', async () => {
    const certs: MtlsClientCerts = {cert: 'fake-cert', key: 'fake-key'};
    const mtlsBase = 'https://agentregistry.mtls.googleapis.com/v1alpha';
    await writeCertSource(homeDir);
    vi.stubEnv('GOOGLE_API_USE_CLIENT_CERTIFICATE', 'true');
    clientCertsToPresentMock.mockResolvedValue(certs);
    const transport = serveSkill({
      defaultRevision: `${RESOURCE_PARENT}/skills/my-skill/revisions/rev-123`,
    });

    const skill = await new GCPSkillRegistry().getSkill('my-skill');

    expect(skill.frontmatter.name).toBe('my-skill');
    expect(transport.calls).toHaveLength(2);
    expect(transport.calls[0].url).toBe(
      `${mtlsBase}/${RESOURCE_PARENT}/skills/my-skill`,
    );
    for (const call of transport.calls) {
      expect(call.agent).toHaveProperty('options.cert', 'fake-cert');
      expect(call.agent).toHaveProperty('options.key', 'fake-key');
    }
    // The certificate provider is a child process and an agent owns a
    // connection pool, so both are built once however many requests are made.
    expect(clientCertsToPresentMock).toHaveBeenCalledTimes(1);
    expect(transport.calls[0].agent).toBe(transport.calls[1].agent);
  });

  it('test_use_custom_credentials', async () => {
    const custom = credentialsFor('custom-token', 'custom-quota-project');
    const transport = stubTransport(custom, () => ({
      body: jsonBody({skills: []}),
    }));

    await new GCPSkillRegistry({credentials: custom}).searchSkills('query');

    expect(getClientMock).not.toHaveBeenCalled();
    expect(transport.calls[0].url).toBe(`${SEARCH_URL}?search_string=query`);
    expect(transport.calls[0].headers).toEqual(
      expectedHeaders('custom-quota-project'),
    );
  });
});
