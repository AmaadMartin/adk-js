/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Client} from '@google-cloud/vertexai';
import {experimental} from '../utils/experimental.js';
import {loadSkillFromZipBuffer} from './loader.js';
import {Frontmatter, Skill} from './skill.js';
import {SkillRegistry} from './skill_registry.js';

/**
 * Ceiling on the base64-encoded skill archive: the encoded size of the 32 MiB
 * uncompressed ceiling adk-python applies in src/google/adk/skills/_utils.py
 * (`_MAX_ZIP_UNCOMPRESSED_BYTES`). Checked on the encoded field so an oversized
 * payload is rejected before the decoded buffer is allocated; base64 padding or
 * line breaks only make this a more conservative bound.
 */
export const MAX_ENCODED_FILESYSTEM_LENGTH =
  Math.ceil((32 * 1024 * 1024) / 3) * 4;

export interface GCPSkillRegistryOptions {
  projectId?: string;
  location?: string;
  client?: Client;
}

/**
 * GCP implementation of SkillRegistry using GCP Skill Registry API.
 */
@experimental
export class GCPSkillRegistry implements SkillRegistry {
  private readonly projectId?: string;
  private readonly location?: string;
  private readonly client: Client;

  constructor(options: GCPSkillRegistryOptions = {}) {
    this.projectId = options.projectId || process.env.GOOGLE_CLOUD_PROJECT;
    this.location = options.location || process.env.GOOGLE_CLOUD_LOCATION;
    this.client =
      options.client ||
      new Client({
        project: this.projectId,
        location: this.location,
      });
  }

  async getSkill(name: string): Promise<Skill> {
    const apiClient = (this.client as unknown as {apiClient: unknown})
      .apiClient as {
      request(req: {
        path: string;
        httpMethod: string;
        httpOptions?: {apiVersion?: string};
      }): Promise<{json(): Promise<Record<string, unknown>>}>;
    };

    const httpResponse = await apiClient.request({
      path: `skills/${name}`,
      httpMethod: 'GET',
      httpOptions: {apiVersion: 'v1beta1'},
    });

    const response = await httpResponse.json();
    const zippedFilesystem =
      (response.zippedFilesystem as string | undefined) ||
      (response.zipped_filesystem as string | undefined);

    if (!zippedFilesystem) {
      throw new Error(`Skill '${name}' does not contain zipped filesystem.`);
    }

    if (zippedFilesystem.length > MAX_ENCODED_FILESYSTEM_LENGTH) {
      throw new Error(
        `Skill '${name}' zipped filesystem is too large: ` +
          `${zippedFilesystem.length} base64 characters exceeds the limit of ` +
          `${MAX_ENCODED_FILESYSTEM_LENGTH}.`,
      );
    }

    const zipBuffer = Buffer.from(zippedFilesystem, 'base64');
    return loadSkillFromZipBuffer(zipBuffer);
  }

  async searchSkills(query: string): Promise<Frontmatter[]> {
    const apiClient = (this.client as unknown as {apiClient: unknown})
      .apiClient as {
      request(req: {
        path: string;
        httpMethod: string;
        body?: string;
        httpOptions?: {apiVersion?: string};
      }): Promise<{json(): Promise<Record<string, unknown>>}>;
    };

    const trimmedQuery = query.trim();
    const isSearch = trimmedQuery.length > 0;
    const path = isSearch
      ? `skills:retrieve?query=${encodeURIComponent(trimmedQuery)}`
      : 'skills';

    const httpResponse = await apiClient.request({
      path,
      httpMethod: 'GET',
      httpOptions: {apiVersion: 'v1beta1'},
    });

    const response = await httpResponse.json();
    const skillsList = isSearch
      ? (response.retrievedSkills as
          | Array<Record<string, unknown>>
          | undefined) ||
        (response.retrieved_skills as
          | Array<Record<string, unknown>>
          | undefined)
      : (response.skills as Array<Record<string, unknown>> | undefined);

    const results: Frontmatter[] = [];
    if (skillsList && Array.isArray(skillsList)) {
      for (const s of skillsList) {
        const skillNameStr =
          (s.skillName as string | undefined) ||
          (s.skill_name as string | undefined) ||
          (s.name as string | undefined) ||
          '';
        const descriptionStr = (s.description as string | undefined) || '';

        const parts = skillNameStr.split('/');
        const name = skillNameStr ? parts[parts.length - 1] : '';
        results.push({
          name,
          description: descriptionStr,
        });
      }
    }
    return results;
  }
}
