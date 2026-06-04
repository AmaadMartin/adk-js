/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {GoogleAuth} from 'google-auth-library';
import {Frontmatter, Skill} from '../../skills/skill.js';
import {SkillRegistry} from '../../skills/skill_registry.js';
import {loadSkillFromZipBytes} from '../../skills/zip_loader.js';

export interface GCPSkillRegistryOptions {
  projectId?: string;
  location?: string;
}

export class GCPSkillRegistry implements SkillRegistry {
  private readonly projectIdPromise: Promise<string>;
  private readonly location: string;
  private readonly auth: GoogleAuth;

  constructor(options: GCPSkillRegistryOptions = {}) {
    this.auth = new GoogleAuth({
      scopes: 'https://www.googleapis.com/auth/cloud-platform',
    });

    this.location =
      options.location || process.env.GOOGLE_CLOUD_LOCATION || 'us-central1';

    if (options.projectId) {
      this.projectIdPromise = Promise.resolve(options.projectId);
    } else if (process.env.GOOGLE_CLOUD_PROJECT) {
      this.projectIdPromise = Promise.resolve(process.env.GOOGLE_CLOUD_PROJECT);
    } else {
      this.projectIdPromise = this.auth.getProjectId();
    }
  }

  private async getRequestHeaders(): Promise<Record<string, string>> {
    const client = await this.auth.getClient();
    const headers = await client.getRequestHeaders();
    return headers as unknown as Record<string, string>;
  }

  async getSkill(name: string): Promise<Skill> {
    const projectId = await this.projectIdPromise;
    if (!projectId) {
      throw new Error('GCP Project ID could not be determined.');
    }

    const urlName = `projects/${projectId}/locations/${this.location}/skills/${name}`;
    const url = `https://${this.location}-aiplatform.googleapis.com/v1beta1/${urlName}`;

    const headers = await this.getRequestHeaders();
    const response = await fetch(url, {headers});

    if (!response.ok) {
      const text = await response.text();
      throw new Error(
        `Failed to fetch skill '${name}' from GCP Skill Registry: HTTP ${response.status} - ${text}`,
      );
    }

    const data = (await response.json()) as {zippedFilesystem?: string};
    if (!data.zippedFilesystem) {
      throw new Error(`Skill '${name}' does not contain zipped filesystem.`);
    }

    const zipBytes = Buffer.from(data.zippedFilesystem, 'base64');
    const skill = await loadSkillFromZipBytes(zipBytes);

    if (skill.frontmatter.name !== name) {
      throw new Error(
        `Skill name '${skill.frontmatter.name}' does not match requested name '${name}'.`,
      );
    }

    return skill;
  }

  async searchSkills(query: string): Promise<Frontmatter[]> {
    const projectId = await this.projectIdPromise;
    if (!projectId) {
      throw new Error('GCP Project ID could not be determined.');
    }

    const url = `https://${this.location}-aiplatform.googleapis.com/v1beta1/projects/${projectId}/locations/${this.location}/skills:retrieve?query=${encodeURIComponent(query)}`;

    const headers = await this.getRequestHeaders();
    const response = await fetch(url, {headers});

    if (!response.ok) {
      const text = await response.text();
      throw new Error(
        `Failed to retrieve skills from GCP Skill Registry: HTTP ${response.status} - ${text}`,
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
        results.push({
          name: s.skillName ? s.skillName.split('/').pop()! : '',
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
