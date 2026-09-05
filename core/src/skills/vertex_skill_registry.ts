/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Client} from '@google-cloud/vertexai';
import {loadSkillFromZipBuffer} from './loader.js';
import {Frontmatter, Skill} from './skill.js';
import {SkillRegistry} from './skill_registry.js';

/** The Vertex AI API version serving the skills collection. */
const API_VERSION = 'v1beta1';

/**
 * Reads the transport out of a Vertex AI {@link Client}.
 *
 * `Client` declares `apiClient` as `protected` and exposes no accessor for it,
 * and a subclass may read a protected member of its own instance type. Going
 * through the client's own transport is what keeps its credentials, project
 * and location in effect.
 */
class VertexTransport extends Client {
  static of(client: VertexTransport) {
    return client.apiClient;
  }
}

/**
 * Reads one search hit as a {@link Frontmatter}.
 *
 * The collection reports a name under three spellings and may report none at
 * all, so an entry the client cannot name becomes the empty name rather than
 * dropping out of the results.
 */
function readSearchHit(entry: Record<string, unknown>): Frontmatter {
  const rawName =
    (entry['skillName'] as string | undefined) ||
    (entry['skill_name'] as string | undefined) ||
    (entry['name'] as string | undefined) ||
    '';
  const parts = rawName.split('/');
  return {
    name: rawName ? parts[parts.length - 1] : '',
    description: (entry['description'] as string | undefined) || '',
  };
}

/**
 * Skill registry backed by the Vertex AI `v1beta1` skills collection.
 *
 * {@link GCPSkillRegistry} selects this transport when a caller supplies a
 * `client`. It has no counterpart in `adk-python`: the Agent Registry API is
 * what both SDKs call by default, and this path exists so a caller that
 * already injects a Vertex AI client keeps working.
 */
export class VertexSkillRegistry implements SkillRegistry {
  constructor(private readonly client: Client) {}

  async getSkill(name: string): Promise<Skill> {
    const response = await this.request(`skills/${name}`);
    const zippedFilesystem =
      (response['zippedFilesystem'] as string | undefined) ||
      (response['zipped_filesystem'] as string | undefined);
    if (!zippedFilesystem) {
      throw new Error(`Skill '${name}' does not contain zipped filesystem.`);
    }
    return loadSkillFromZipBuffer(Buffer.from(zippedFilesystem, 'base64'));
  }

  async searchSkills(query: string): Promise<Frontmatter[]> {
    const trimmedQuery = query.trim();
    const isSearch = trimmedQuery.length > 0;
    const response = await this.request(
      isSearch
        ? `skills:retrieve?query=${encodeURIComponent(trimmedQuery)}`
        : 'skills',
    );

    const hits = isSearch
      ? response['retrievedSkills'] || response['retrieved_skills']
      : response['skills'];
    return Array.isArray(hits) ? hits.map(readSearchHit) : [];
  }

  private async request(path: string): Promise<Record<string, unknown>> {
    const response = await VertexTransport.of(this.client).request({
      path,
      httpMethod: 'GET',
      httpOptions: {apiVersion: API_VERSION},
    });
    return (await response.json()) as Record<string, unknown>;
  }
}
