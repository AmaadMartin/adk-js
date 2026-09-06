/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Client} from '@google-cloud/vertexai';
import {AuthClient, GoogleAuth} from 'google-auth-library';
import * as https from 'node:https';
import {getTrackingHeaders} from '../utils/client_labels.js';
import {formatError} from '../utils/error_utils.js';
import {experimental} from '../utils/experimental.js';
import {readOwnString} from '../utils/json_utils.js';
import {logger} from '../utils/logger.js';
import {
  chooseApiEndpointForDefaultCerts,
  clientCertsToPresent,
} from '../utils/mtls_utils.js';
import {loadSkillFromZipBuffer} from './loader.js';
import {
  Frontmatter,
  FrontmatterSchema,
  Skill,
  SNAKE_OR_KEBAB_NAME_PATTERN,
} from './skill.js';
import {SkillRegistry} from './skill_registry.js';
import {
  vertexApiTransport,
  VertexSkillRegistry,
} from './vertex_skill_registry.js';

/** The Agent Registry host serving the Skill Registry API. */
const DEFAULT_ENDPOINT = 'https://agentregistry.googleapis.com/v1alpha';

/** The mutual-TLS variant of {@link DEFAULT_ENDPOINT}. */
const MTLS_ENDPOINT = 'https://agentregistry.mtls.googleapis.com/v1alpha';

/** The environment variable that redirects every call to another deployment. */
const ENDPOINT_ENV = 'AGENT_REGISTRY_ENDPOINT';

/** How long one Agent Registry request may take before it is abandoned. */
const REQUEST_TIMEOUT_MS = 30_000;

const CLOUD_PLATFORM_SCOPE = 'https://www.googleapis.com/auth/cloud-platform';

/** Options for {@link GCPSkillRegistry}. */
export interface GCPSkillRegistryOptions {
  /** GCP project id. Falls back to `GOOGLE_CLOUD_PROJECT`. */
  projectId?: string;
  /** GCP location. Falls back to `GOOGLE_CLOUD_LOCATION`. */
  location?: string;
  /** Credentials to use instead of application default credentials. */
  credentials?: AuthClient;
  /**
   * Vertex AI client selecting the `v1beta1` skills collection instead of the
   * Agent Registry API. The client carries its own project, location and
   * credentials, so the other options do not apply to it.
   */
  client?: Client;
}

/**
 * Reads one search hit as a {@link Frontmatter}, or returns `undefined` when
 * the client cannot represent it.
 *
 * The caller does not control what the catalogue holds, so a hit that fails
 * frontmatter validation is skipped and logged rather than raised: one entry
 * the caller never asked about must not break discovery for every other hit.
 * A name that is not a string is as much outside the caller's control, so it
 * becomes the empty name and takes the same skip path.
 */
function readSearchHit(entry: unknown): Frontmatter | undefined {
  const rawName = readOwnString(entry, 'name') ?? '';
  const name = rawName.slice(rawName.lastIndexOf('/') + 1);
  const description = readOwnString(entry, 'description') ?? '';

  const parsed = FrontmatterSchema.safeParse({name, description});
  if (parsed.success) {
    return parsed.data;
  }
  logger.warn(
    `Skipping search result '${name}': it does not pass frontmatter ` +
      `validation: ${parsed.error.message}`,
  );
  return undefined;
}

/** Skill registry backed by the Agent Registry API. */
class AgentRegistrySkillRegistry implements SkillRegistry {
  private readonly projectId: string;
  private readonly baseUrl: string;
  private readonly resourceParent: string;
  private credentials?: AuthClient;
  private agent?: Promise<https.Agent | undefined>;

  constructor(options: GCPSkillRegistryOptions = {}) {
    const projectId = options.projectId || process.env['GOOGLE_CLOUD_PROJECT'];
    const location = options.location || process.env['GOOGLE_CLOUD_LOCATION'];
    if (!projectId || !location) {
      throw new Error(
        'project_id and location must be specified or set via environment' +
          ' variables.',
      );
    }
    this.projectId = projectId;
    this.resourceParent = `projects/${projectId}/locations/${location}`;
    this.baseUrl =
      process.env[ENDPOINT_ENV] ||
      chooseApiEndpointForDefaultCerts(DEFAULT_ENDPOINT, MTLS_ENDPOINT);
    this.credentials = options.credentials;
  }

  async getSkill(name: string): Promise<Skill> {
    // The name reaches here straight from a model-issued tool call, so it must
    // be a single path segment before it is interpolated into the request URL.
    if (!SNAKE_OR_KEBAB_NAME_PATTERN.test(name)) {
      throw new Error(
        `Invalid skill name '${name}': name must be lowercase kebab-case` +
          ' (a-z, 0-9, hyphens) or snake_case (a-z, 0-9, underscores), with' +
          ' no leading, trailing, or consecutive delimiters.',
      );
    }

    const skillUrl =
      `${this.baseUrl}/${this.resourceParent}` +
      `/skills/${encodeURIComponent(name)}`;
    const skillData = await this.getJson<{
      defaultRevision?: string;
      default_revision?: string;
    }>(skillUrl);

    const defaultRevision =
      skillData.defaultRevision || skillData.default_revision;
    if (!defaultRevision) {
      throw new Error(`Skill '${name}' does not contain default revision.`);
    }

    return loadSkillFromZipBuffer(
      await this.get(`${this.baseUrl}/${defaultRevision}`, {alt: 'media'}),
    );
  }

  async searchSkills(query: string): Promise<Frontmatter[]> {
    const {skills} = await this.getJson<{skills?: unknown[]}>(
      `${this.baseUrl}/${this.resourceParent}/skills:search`,
      {search_string: query},
    );
    if (!Array.isArray(skills)) {
      return [];
    }
    return skills
      .map(readSearchHit)
      .filter((hit): hit is Frontmatter => hit !== undefined);
  }

  /**
   * Returns the credentials, resolving application default credentials on the
   * first call so that building a registry costs no I/O.
   */
  private async resolveCredentials(): Promise<AuthClient> {
    if (!this.credentials) {
      try {
        this.credentials = await new GoogleAuth({
          scopes: [CLOUD_PLATFORM_SCOPE],
        }).getClient();
      } catch (error: unknown) {
        throw new Error(
          `Failed to get default Google Cloud credentials: ${formatError(error)}`,
        );
      }
    }
    return this.credentials;
  }

  /**
   * Sends one authenticated GET and returns the body as raw bytes.
   *
   * The body is never decoded here, so the same call serves the JSON skill
   * metadata and the zip archive of a revision. The credentials own the
   * transport, so they add the bearer token themselves; a configured client
   * certificate travels on the agent.
   */
  private async get(
    url: string,
    params?: Record<string, string>,
  ): Promise<Buffer> {
    const credentials = await this.resolveCredentials();
    // The certificate provider is a child process, and an agent owns a
    // connection pool, so both are built at most once per registry.
    this.agent ??= clientCertsToPresent().then(
      (certs) => certs && new https.Agent(certs),
    );

    let status: number;
    let body: Buffer;
    try {
      const response = await credentials.request<ArrayBuffer>({
        url: params ? `${url}?${new URLSearchParams(params).toString()}` : url,
        headers: {
          ...getTrackingHeaders(),
          'Content-Type': 'application/json',
          'x-goog-user-project': credentials.quotaProjectId || this.projectId,
        },
        responseType: 'arraybuffer',
        timeout: REQUEST_TIMEOUT_MS,
        agent: await this.agent,
        validateStatus: () => true,
      });
      status = response.status;
      body = Buffer.from(response.data);
    } catch (error: unknown) {
      throw new Error(`API request failed: ${formatError(error)}`);
    }

    if (status < 200 || status >= 300) {
      throw new Error(
        `API request failed with status ${status}: ${body.toString('utf-8')}`,
      );
    }
    return body;
  }

  /** Sends one authenticated GET and parses the body as JSON. */
  private async getJson<T>(
    url: string,
    params?: Record<string, string>,
  ): Promise<T> {
    return JSON.parse((await this.get(url, params)).toString('utf-8')) as T;
  }
}

/**
 * GCP implementation of SkillRegistry.
 *
 * Calls the Agent Registry API, which is the transport `adk-python` uses. A
 * caller that supplies a `client` gets the Vertex AI `v1beta1` skills
 * collection instead, which only `adk-js` offers.
 */
@experimental
export class GCPSkillRegistry implements SkillRegistry {
  private readonly delegate: SkillRegistry;

  constructor(options: GCPSkillRegistryOptions = {}) {
    this.delegate = options.client
      ? new VertexSkillRegistry(vertexApiTransport(options.client))
      : new AgentRegistrySkillRegistry(options);
  }

  getSkill(name: string): Promise<Skill> {
    return this.delegate.getSkill(name);
  }

  searchSkills(query: string): Promise<Frontmatter[]> {
    return this.delegate.searchSkills(query);
  }
}
