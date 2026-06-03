/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {GoogleAuth} from 'google-auth-library';
import JSZip from 'jszip';
import {parseSkillMdContent} from '../../skills/loader.js';
import {Frontmatter, Resources, Script, Skill} from '../../skills/skill.js';
import {SkillRegistry} from '../../skills/skill_registry.js';

export interface GCPSkillRegistryOptions {
  projectId?: string | null;
  location?: string | null;
}

/**
 * Helper to check if a buffer contains binary data.
 */
function isBinaryBuffer(buffer: Buffer): boolean {
  const limit = Math.min(buffer.length, 8000);
  for (let i = 0; i < limit; i++) {
    if (buffer[i] === 0) {
      return true;
    }
  }
  return false;
}

/**
 * GCP implementation of SkillRegistry using GCP Vertex AI Skill Registry API.
 */
export class GCPSkillRegistry extends SkillRegistry {
  readonly projectId: string;
  readonly location: string;
  private readonly auth: GoogleAuth;

  constructor(options?: GCPSkillRegistryOptions) {
    super();
    this.projectId =
      options?.projectId || process.env.GOOGLE_CLOUD_PROJECT || '';
    this.location =
      options?.location || process.env.GOOGLE_CLOUD_LOCATION || '';

    if (!this.projectId || !this.location) {
      throw new Error(
        'projectId and location must be provided or set in environment variables',
      );
    }

    this.auth = new GoogleAuth({
      scopes: ['https://www.googleapis.com/auth/cloud-platform'],
    });
  }

  /**
   * Resolves default Google Cloud credentials and returns standard headers.
   */
  private async getAuthHeaders(): Promise<Record<string, string>> {
    try {
      const client = await this.auth.getClient();
      const headers = await client.getRequestHeaders(
        'https://aiplatform.googleapis.com',
      );
      const authHeaders: Record<string, string> = {};
      const rawHeaders = headers as unknown as Record<string, string>;
      const authKey = Object.keys(rawHeaders).find(
        (k) => k.toLowerCase() === 'authorization',
      );
      let token = authKey ? rawHeaders[authKey] : undefined;

      if (
        !token &&
        client.credentials &&
        (client.credentials as {access_token?: string}).access_token
      ) {
        token = `Bearer ${(client.credentials as {access_token?: string}).access_token}`;
      }

      if (token) {
        authHeaders['Authorization'] = token;
      }
      authHeaders['Content-Type'] = 'application/json';

      const quotaProjectId =
        (client as unknown as {quotaProjectId?: string}).quotaProjectId ||
        (this.auth as unknown as {quotaProjectId?: string}).quotaProjectId;
      if (quotaProjectId) {
        authHeaders['x-goog-user-project'] = quotaProjectId;
      }
      return authHeaders;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`Failed to refresh Google Cloud credentials: ${msg}`);
    }
  }

  /**
   * Fetches a skill from the registry.
   */
  async getSkill(params: {name: string}): Promise<Skill> {
    const {name} = params;
    const url = `https://${this.location}-aiplatform.googleapis.com/v1beta1/projects/${this.projectId}/locations/${this.location}/skills/${name}`;

    let res: Response;
    try {
      const headers = await this.getAuthHeaders();
      res = await fetch(url, {
        method: 'GET',
        headers,
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`API request failed: ${msg}`);
    }

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`API request failed with status ${res.status}: ${text}`);
    }

    const data = (await res.json()) as {zippedFilesystem?: string};
    const zipBytesBase64 = data.zippedFilesystem;
    if (!zipBytesBase64) {
      throw new Error(`Skill '${name}' does not contain zipped filesystem.`);
    }

    const zipBytes = Buffer.from(zipBytesBase64, 'base64');
    return this.loadSkillFromZipBytes(zipBytes, name);
  }

  /**
   * Searches for skills in the registry.
   */
  async searchSkills(params: {query: string}): Promise<Frontmatter[]> {
    const {query} = params;
    const searchParams = new URLSearchParams({query});
    const url = `https://${this.location}-aiplatform.googleapis.com/v1beta1/projects/${this.projectId}/locations/${this.location}/skills:retrieve?${searchParams.toString()}`;

    let res: Response;
    try {
      const headers = await this.getAuthHeaders();
      res = await fetch(url, {
        method: 'GET',
        headers,
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`API request failed: ${msg}`);
    }

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`API request failed with status ${res.status}: ${text}`);
    }

    const data = (await res.json()) as {
      retrievedSkills?: Array<{
        skillName?: string;
        description?: string;
      }>;
    };

    const results: Frontmatter[] = [];
    if (data.retrievedSkills) {
      for (const s of data.retrievedSkills) {
        const skillName = s.skillName || '';
        const name = skillName.split('/').pop() || '';
        results.push({
          name,
          description: s.description || '',
        });
      }
    }
    return results;
  }

  /**
   * Helper to load a skill from raw zip bytes.
   */
  private async loadSkillFromZipBytes(
    zipBytes: Buffer,
    expectedName?: string,
  ): Promise<Skill> {
    let zip: JSZip;
    try {
      zip = await JSZip.loadAsync(zipBytes);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`Failed to load zip file: ${msg}`);
    }

    // Zip Slip check
    for (const relativePath of Object.keys(zip.files)) {
      if (
        relativePath.startsWith('/') ||
        relativePath.startsWith('../') ||
        relativePath.includes('/../')
      ) {
        throw new Error(`Dangerous zip entry ignored: ${relativePath}`);
      }
    }

    const skillMdFile = zip.file('SKILL.md') || zip.file('skill.md');
    if (!skillMdFile) {
      throw new Error('SKILL.md not found in zipped filesystem.');
    }

    const skillMdContent = await skillMdFile.async('string');
    const {frontmatter, body} = parseSkillMdContent(skillMdContent);

    if (expectedName && frontmatter.name !== expectedName) {
      throw new Error(
        `Skill name '${frontmatter.name}' does not match requested name '${expectedName}'.`,
      );
    }

    const references: Record<string, string | Buffer> = {};
    const assets: Record<string, string | Buffer> = {};
    const scripts: Record<string, Script> = {};

    for (const [relativePath, file] of Object.entries(zip.files)) {
      if (file.dir) continue;

      if (relativePath.startsWith('references/')) {
        const key = relativePath.substring('references/'.length);
        if (key) {
          const buffer = await file.async('nodebuffer');
          if (isBinaryBuffer(buffer)) {
            references[key] = buffer;
          } else {
            references[key] = buffer.toString('utf-8');
          }
        }
      } else if (relativePath.startsWith('assets/')) {
        const key = relativePath.substring('assets/'.length);
        if (key) {
          const buffer = await file.async('nodebuffer');
          if (isBinaryBuffer(buffer)) {
            assets[key] = buffer;
          } else {
            assets[key] = buffer.toString('utf-8');
          }
        }
      } else if (relativePath.startsWith('scripts/')) {
        const key = relativePath.substring('scripts/'.length);
        if (key) {
          const src = await file.async('string');
          scripts[key] = {src};
        }
      }
    }

    const resources: Resources = {references, assets, scripts};

    return {
      frontmatter,
      instructions: body,
      resources,
    };
  }
}
