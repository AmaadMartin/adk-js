/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Client} from '@google-cloud/vertexai';
import {readOwn, readOwnString} from '../utils/json_utils.js';
import {loadSkillFromZipBuffer} from './loader.js';
import {Frontmatter, Skill} from './skill.js';
import {SkillRegistry} from './skill_registry.js';

/** The Vertex AI API version serving the skills collection. */
const API_VERSION = 'v1beta1';

/** The part of a Vertex AI client's transport this registry calls. */
export interface VertexApiTransport {
  request(request: {
    path: string;
    httpMethod: 'GET';
    httpOptions: {apiVersion: string};
  }): Promise<{json(): Promise<unknown>}>;
}

/**
 * Reads the transport out of a Vertex AI {@link Client}.
 *
 * `Client` declares `apiClient` as `protected` and exposes no accessor for it,
 * and a subclass may read a protected member of its own instance type. Going
 * through the client's own transport is what keeps its credentials, its
 * project and its location in effect.
 */
class TransportReader extends Client {
  static of(client: TransportReader): VertexApiTransport {
    return client.apiClient;
  }
}

/** Returns the transport a Vertex AI {@link Client} sends requests through. */
export function vertexApiTransport(client: Client): VertexApiTransport {
  return TransportReader.of(client);
}

/**
 * Reads one search hit as a {@link Frontmatter}.
 *
 * The collection reports a name under three spellings and may report none at
 * all, so an entry the client cannot name becomes the empty name rather than
 * dropping out of the results.
 */
function readSearchHit(entry: unknown): Frontmatter {
  const rawName =
    readOwnString(entry, 'skillName') ||
    readOwnString(entry, 'skill_name') ||
    readOwnString(entry, 'name') ||
    '';
  return {
    name: rawName.slice(rawName.lastIndexOf('/') + 1),
    description: readOwnString(entry, 'description') || '',
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
  constructor(private readonly transport: VertexApiTransport) {}

  async getSkill(name: string): Promise<Skill> {
    const response = await this.request(`skills/${name}`);
    const zippedFilesystem =
      readOwnString(response, 'zippedFilesystem') ||
      readOwnString(response, 'zipped_filesystem');
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
      ? readOwn(response, 'retrievedSkills') ||
        readOwn(response, 'retrieved_skills')
      : readOwn(response, 'skills');
    return Array.isArray(hits) ? hits.map(readSearchHit) : [];
  }

  private async request(path: string): Promise<unknown> {
    const response = await this.transport.request({
      path,
      httpMethod: 'GET',
      httpOptions: {apiVersion: API_VERSION},
    });
    return response.json();
  }
}
