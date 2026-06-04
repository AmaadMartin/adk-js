/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Client} from '@google-cloud/vertexai/build/src/genai/client.js';
import {ApiClient} from '@google/genai/vertex_internal';
import {loadSkillFromZipBytes} from '../../skills/loader.js';
import {Frontmatter, Skill} from '../../skills/skill.js';
import {SkillRegistry} from '../../skills/skill_registry.js';

interface VertexSkillResource {
  name?: string;
  description?: string;
  zippedFilesystem?: string; // Base64 encoded
}

interface VertexRetrieveSkillsResponse {
  retrievedSkills?: Array<{
    skillName?: string;
    description?: string;
  }>;
}

/**
 * GCP implementation of SkillRegistry using GCP Skill Registry API.
 */
export class GCPSkillRegistry implements SkillRegistry {
  private readonly client: Client;
  private readonly projectId: string;
  private readonly location: string;

  constructor(options?: {projectId?: string; location?: string}) {
    this.projectId =
      options?.projectId || process.env['GOOGLE_CLOUD_PROJECT'] || '';
    this.location =
      options?.location ||
      process.env['GOOGLE_CLOUD_LOCATION'] ||
      'us-central1';
    this.client = new Client({
      project: this.projectId,
      location: this.location,
    });
  }

  async getSkill(params: {name: string}): Promise<Skill> {
    const {name} = params;
    const fullPath = `projects/${this.projectId}/locations/${this.location}/skills/${name}`;

    const apiClient = (this.client as unknown as {apiClient: ApiClient})
      .apiClient;
    const httpResponse = await apiClient.request({
      path: fullPath,
      httpMethod: 'GET',
    });

    const skillResource = (await httpResponse.json()) as VertexSkillResource;
    const zipBytesBase64 = skillResource.zippedFilesystem;
    if (!zipBytesBase64) {
      throw new Error(`Skill '${name}' does not contain zipped filesystem.`);
    }

    const zipBytes = Buffer.from(zipBytesBase64, 'base64');
    return loadSkillFromZipBytes(zipBytes);
  }

  async searchSkills(params: {query: string}): Promise<Frontmatter[]> {
    const {query} = params;
    const fullPath = `projects/${this.projectId}/locations/${this.location}/skills:retrieve`;

    const apiClient = (this.client as unknown as {apiClient: ApiClient})
      .apiClient;
    const httpResponse = await apiClient.request({
      path: fullPath,
      httpMethod: 'GET',
      queryParams: {query},
    });

    const response =
      (await httpResponse.json()) as VertexRetrieveSkillsResponse;
    const results: Frontmatter[] = [];
    if (response.retrievedSkills) {
      for (const s of response.retrievedSkills) {
        const name = s.skillName ? s.skillName.split('/').pop() || '' : '';
        results.push({
          name,
          description: s.description || '',
        });
      }
    }
    return results;
  }

  searchToolDescription(): string | null {
    return null;
  }
}
