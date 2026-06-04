/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Client} from '@google-cloud/vertexai/build/src/genai/client.js';
import * as fflate from 'fflate';
import {parseSkillMdContent} from '../../skills/loader.js';
import {
  Frontmatter,
  FrontmatterSchema,
  Resources,
  Script,
  Skill,
} from '../../skills/skill.js';
import {SkillRegistry} from '../../skills/skill_registry.js';
import {logger} from '../../utils/logger.js';

interface InternalApiClient {
  request(params: {
    path: string;
    httpMethod: string;
    body?: string;
  }): Promise<{json(): Promise<unknown>}>;
}

interface InternalClient {
  apiClient: InternalApiClient;
}

interface GetSkillResponse {
  zippedFilesystem?: string;
  zipped_filesystem?: string;
}

interface RetrievedSkill {
  skillName?: string;
  skill_name?: string;
  description?: string;
}

interface SearchSkillsResponse {
  retrievedSkills?: RetrievedSkill[];
  retrieved_skills?: RetrievedSkill[];
}

/**
 * GCP implementation of SkillRegistry using Vertex AI Skill Registry API.
 */
export class GCPSkillRegistry extends SkillRegistry {
  private readonly projectId: string;
  private readonly location: string;
  private readonly client: Client;

  constructor(params?: {projectId?: string; location?: string}) {
    super();
    this.projectId =
      params?.projectId || process.env['GOOGLE_CLOUD_PROJECT'] || '';
    this.location =
      params?.location || process.env['GOOGLE_CLOUD_LOCATION'] || '';

    if (!this.projectId || !this.location) {
      throw new Error(
        'Project ID and Location must be provided or set in environment variables (GOOGLE_CLOUD_PROJECT, GOOGLE_CLOUD_LOCATION).',
      );
    }

    this.client = new Client({
      project: this.projectId,
      location: this.location,
    });
  }

  async getSkill(params: {name: string}): Promise<Skill> {
    const fullName = `projects/${this.projectId}/locations/${this.location}/skills/${params.name}`;

    logger.debug(`Fetching skill ${fullName} from GCP registry`);
    const apiClient = (this.client as unknown as InternalClient).apiClient;
    const response = await apiClient.request({
      path: fullName,
      httpMethod: 'GET',
    });

    const responseJson = (await response.json()) as GetSkillResponse;
    const zipBytesBase64 =
      responseJson.zippedFilesystem || responseJson.zipped_filesystem;
    if (!zipBytesBase64) {
      throw new Error(
        `Skill '${params.name}' does not contain zipped filesystem.`,
      );
    }

    const zipBytes = Buffer.from(zipBytesBase64, 'base64');
    return this.loadSkillFromZipBytes(zipBytes, params.name);
  }

  async searchSkills(params: {query: string}): Promise<Frontmatter[]> {
    logger.debug(`Searching skills with query: ${params.query}`);
    const apiClient = (this.client as unknown as InternalClient).apiClient;
    const path = `projects/${this.projectId}/locations/${this.location}/skills:retrieve`;

    const response = await apiClient.request({
      path: path,
      httpMethod: 'POST',
      body: JSON.stringify({query: params.query}),
    });

    const responseJson = (await response.json()) as SearchSkillsResponse;
    const retrievedSkills =
      responseJson.retrievedSkills || responseJson.retrieved_skills;

    const results: Frontmatter[] = [];
    if (retrievedSkills) {
      for (const s of retrievedSkills) {
        const skillName = s.skillName || s.skill_name;
        const name = skillName ? skillName.split('/').pop() : '';
        results.push({
          name: name || '',
          description: s.description || '',
        });
      }
    }
    return results;
  }

  private loadSkillFromZipBytes(
    zipBytes: Uint8Array,
    expectedName: string,
  ): Skill {
    let unzipped: Record<string, Uint8Array>;
    try {
      unzipped = fflate.unzipSync(zipBytes);
    } catch (e: unknown) {
      throw new Error(`Failed to unzip skill archive: ${(e as Error).message}`);
    }

    const files: Record<string, string | Buffer> = {};
    for (const [filename, content] of Object.entries(unzipped)) {
      // Zip Slip validation: check for directory traversal
      if (filename.includes('..') || filename.startsWith('/')) {
        throw new Error(`Zip Slip detected in skill archive: ${filename}`);
      }

      try {
        const decoder = new TextDecoder('utf-8', {fatal: true});
        files[filename] = decoder.decode(content);
      } catch {
        files[filename] = Buffer.from(content);
      }
    }

    let skillMdKey = '';
    for (const key of Object.keys(files)) {
      if (key.toLowerCase() === 'skill.md') {
        skillMdKey = key;
        break;
      }
    }

    if (!skillMdKey) {
      throw new Error('SKILL.md not found in skill archive.');
    }

    const skillMdContent = files[skillMdKey];
    if (typeof skillMdContent !== 'string') {
      throw new Error('SKILL.md must be a text file.');
    }

    const {frontmatter: parsed, body} = parseSkillMdContent(skillMdContent);
    const frontmatter = FrontmatterSchema.parse(parsed);

    if (frontmatter.name !== expectedName) {
      throw new Error(
        `Skill name '${frontmatter.name}' in SKILL.md does not match requested name '${expectedName}'.`,
      );
    }

    const references: Record<string, string | Buffer> = {};
    const assets: Record<string, string | Buffer> = {};
    const scripts: Record<string, Script> = {};

    for (const [filename, content] of Object.entries(files)) {
      if (filename === skillMdKey) continue;

      const parts = filename.split('/');
      if (parts.length > 1) {
        const category = parts[0];
        const relativePath = parts.slice(1).join('/');

        if (category === 'references') {
          references[relativePath] = content;
        } else if (category === 'assets') {
          assets[relativePath] = content;
        } else if (category === 'scripts') {
          if (typeof content === 'string') {
            scripts[relativePath] = {src: content};
          }
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
