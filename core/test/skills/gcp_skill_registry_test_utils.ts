/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/** Fixtures shared by the two GCPSkillRegistry test files. */

import AdmZip from 'adm-zip';
import {AuthClient, OAuth2Client} from 'google-auth-library';
import {expect, vi} from 'vitest';

/** The init argument of `globalThis.fetch`. */
export type FetchInit = Parameters<typeof fetch>[1];

export const TEST_PROJECT = 'test-project';
export const TEST_LOCATION = 'us-central1';

/** The Agent Registry host the registry calls when nothing overrides it. */
export const DEFAULT_BASE_URL = 'https://agentregistry.googleapis.com/v1alpha';

/** The parent resource every skill of the test project lives under. */
export const RESOURCE_PARENT = `projects/${TEST_PROJECT}/locations/${TEST_LOCATION}`;

/**
 * Builds the zip archive of a skill whose `SKILL.md` holds `skillMd`.
 *
 * @param rawEntryName An extra member, written onto the entry after it is
 *     added because `adm-zip` normalizes a traversal name given to `addFile`.
 */
export function createSkillZip(
  skillMd = '---\nname: my-skill\ndescription: test\n---\n# My Skill\n',
  rawEntryName?: string,
): Buffer {
  const zip = new AdmZip();
  zip.addFile('SKILL.md', Buffer.from(skillMd, 'utf-8'));
  if (rawEntryName !== undefined) {
    zip.addFile('placeholder.txt', Buffer.from('x', 'utf-8'));
    const placeholder = zip
      .getEntries()
      .find((entry) => entry.entryName === 'placeholder.txt');
    if (!placeholder) {
      expect.fail('fixture setup failed: placeholder.txt was not added');
    }
    placeholder.entryName = rawEntryName;
  }
  return zip.toBuffer();
}

/** Builds a response carrying `body` as JSON. */
export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(Buffer.from(JSON.stringify(body), 'utf-8'), {status});
}

/** Builds a response carrying `body` as raw bytes. */
export function bytesResponse(body: Buffer, status = 200): Response {
  // A `Buffer` may be backed by a `SharedArrayBuffer`, which `BodyInit` does
  // not accept, so the bytes are copied into a plain view first.
  return new Response(new Uint8Array(body), {status});
}

/**
 * Builds real credentials that answer with `token`.
 *
 * A real `OAuth2Client` stands in for the credentials so that the registry
 * sees the `AuthClient` contract it declares, rather than a cast object
 * literal.
 */
export function credentialsFor(
  token: string,
  quotaProjectId?: string,
): AuthClient {
  // Typed as the base class, whose `getAccessToken` carries a single
  // signature: `OAuth2Client` overloads it with a callback form, and a spy on
  // the subclass resolves to that overload instead.
  const client: AuthClient = new OAuth2Client();
  client.quotaProjectId = quotaProjectId;
  vi.spyOn(client, 'getAccessToken').mockResolvedValue({token});
  return client;
}
