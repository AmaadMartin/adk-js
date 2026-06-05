/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {GoogleAuth} from 'google-auth-library';
import {loadSkillFromZipBytes} from '../../skills/loader.js';
import {Frontmatter, Skill} from '../../skills/skill.js';
import {SkillRegistry} from '../../skills/skill_registry.js';

export interface GCPSkillRegistryOptions {
  projectId?: string;
  location?: string;
}

/**
 * GCP implementation of SkillRegistry using GCP Skill Registry API.
 */
export class GCPSkillRegistry extends SkillRegistry {
  private readonly projectId: string;
  private readonly location: string;
  private readonly auth: GoogleAuth;

  constructor(options?: GCPSkillRegistryOptions) {
    super();
    this.projectId =
      options?.projectId || process.env['GOOGLE_CLOUD_PROJECT'] || '';
    this.location =
      options?.location ||
      process.env['GOOGLE_CLOUD_LOCATION'] ||
      'us-central1';

    if (!this.projectId) {
      throw new Error(
        'Project ID must be specified or set via GOOGLE_CLOUD_PROJECT environment variable.',
      );
    }
    this.auth = new GoogleAuth({
      scopes: 'https://www.googleapis.com/auth/cloud-platform',
    });
  }

  private async getAuthHeaders(): Promise<Record<string, string>> {
    const client = await this.auth.getClient();
    const headers = await client.getRequestHeaders();
    return headers as unknown as Record<string, string>;
  }

  async getSkill(params: {name: string}): Promise<Skill> {
    const {name} = params;
    const headers = await this.getAuthHeaders();
    const url = `https://${this.location}-aiplatform.googleapis.com/v1beta1/projects/${this.projectId}/locations/${this.location}/skills/${name}`;

    const response = await fetch(url, {
      method: 'GET',
      headers,
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(
        `Failed to fetch skill '${name}' (HTTP ${response.status}): ${errorText}`,
      );
    }

    const data = (await response.json()) as {zippedFilesystem?: string};

    const zipBytesBase64 = data.zippedFilesystem;
    if (!zipBytesBase64) {
      throw new Error(`Skill '${name}' does not contain zipped filesystem.`);
    }

    const zipBytes = Buffer.from(zipBytesBase64, 'base64');
    return loadSkillFromZipBytes(zipBytes);
  }

  async searchSkills(params: {query: string}): Promise<Frontmatter[]> {
    const {query} = params;
    const headers = await this.getAuthHeaders();
    const url = `https://${this.location}-aiplatform.googleapis.com/v1beta1/projects/${this.projectId}/locations/${this.location}/skills:retrieve?query=${encodeURIComponent(
      query,
    )}`;

    const response = await fetch(url, {
      method: 'GET',
      headers,
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(
        `Failed to retrieve skills (HTTP ${response.status}): ${errorText}`,
      );
    }

    const data = (await response.json()) as {
      retrievedSkills?: Array<{
        skillName?: string;
        description?: string;
      }>;
    };

    const results: Frontmatter[] = [];
    if (data.retrievedSkills) {
      for (const s of data.retrievedSkills) {
        const name = s.skillName ? s.skillName.split('/').pop() || '' : '';
        results.push({
          name,
          description: s.description || '',
        });
      }
    }
    return results;
  }
}
