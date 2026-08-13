/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Bucket, File, Storage, StorageOptions} from '@google-cloud/storage';
import {createPartFromBase64, createPartFromText, Part} from '@google/genai';
import {logger} from '../utils/logger.js';

import {
  assertArtifactReferenceDepth,
  isArtifactUri,
  parseArtifactReference,
  validatePathSegment,
} from './artifact_util.js';
import {
  ArtifactVersion,
  BaseArtifactService,
  DeleteArtifactRequest,
  ListArtifactKeysRequest,
  ListVersionsRequest,
  LoadArtifactRequest,
  SaveArtifactRequest,
} from './base_artifact_service.js';

const GCS_FILE_URI_METADATA_KEY = 'adkFileUri';
const GCS_FILE_MIME_TYPE_METADATA_KEY = 'adkFileMimeType';
const GCS_DISPLAY_NAME_METADATA_KEY = 'adkDisplayName';
const GCS_IS_TEXT_METADATA_KEY = 'adkIsText';
const USER_NAMESPACE_PREFIX = 'user:';

/**
 * A stored blob, before it is turned back into a Part.
 *
 * A `reference` blob holds a file URI in its metadata and carries no bytes.
 */
type StoredArtifact =
  | {kind: 'reference'; fileUri: string; mimeType?: string}
  | {
      kind: 'content';
      data: Buffer;
      contentType?: string;
      displayName?: string;
      isText: boolean;
    };

export class GcsArtifactService implements BaseArtifactService {
  private readonly bucket: Bucket;

  constructor(bucket: string, options?: StorageOptions) {
    this.bucket = new Storage(options).bucket(bucket);
  }

  async saveArtifact(request: SaveArtifactRequest): Promise<number> {
    if (
      !request.artifact.inlineData &&
      !request.artifact.text &&
      !request.artifact.fileData
    ) {
      throw new Error('Artifact must have either inlineData or text content.');
    }

    const versions = await this.listVersions(request);
    const version = versions.length > 0 ? Math.max(...versions) + 1 : 0;
    const file = this.bucket.file(
      getFileName({
        ...request,
        version,
      }),
    );

    const customMetadata: Record<string, unknown> = {
      ...request.customMetadata,
    };

    if (request.artifact.inlineData) {
      if (request.artifact.inlineData.displayName) {
        customMetadata[GCS_DISPLAY_NAME_METADATA_KEY] =
          request.artifact.inlineData.displayName;
      }
      await file.save(
        Buffer.from(request.artifact.inlineData.data || '', 'base64'),
        {
          contentType: request.artifact.inlineData.mimeType,
          metadata: {metadata: customMetadata},
        },
      );

      return version;
    } else if (request.artifact.text !== undefined) {
      await file.save(request.artifact.text, {
        contentType: 'text/plain',
        metadata: {
          metadata: {...customMetadata, [GCS_IS_TEXT_METADATA_KEY]: 'true'},
        },
      });

      return version;
    } else {
      const fileData = request.artifact.fileData;
      const fileUri = fileData?.fileUri;
      if (!fileUri) {
        throw new Error('Artifact fileData must have a fileUri.');
      }
      if (isArtifactUri(fileUri)) {
        parseArtifactReference({
          appName: request.appName,
          userId: request.userId,
          sessionId: request.sessionId,
          fileUri,
        });
      }
      // Store the URI and mime_type (if any) as blob metadata; no content to upload.
      customMetadata[GCS_FILE_URI_METADATA_KEY] = fileUri;
      if (fileData.mimeType) {
        customMetadata[GCS_FILE_MIME_TYPE_METADATA_KEY] = fileData.mimeType;
      }
      await file.save('', {
        contentType: fileData.mimeType || undefined,
        metadata: {metadata: customMetadata},
      });
      return version;
    }
  }

  async loadArtifact(request: LoadArtifactRequest): Promise<Part | undefined> {
    return this.loadArtifactAtDepth(request, 0);
  }

  private async loadArtifactAtDepth(
    request: LoadArtifactRequest,
    depth: number,
  ): Promise<Part | undefined> {
    // Runs outside readStoredArtifact so a rejection is not reported as a
    // missing artifact.
    validateBlobPathSegments(request);

    const stored = await this.readStoredArtifact(request);
    if (!stored) {
      return undefined;
    }

    if (stored.kind === 'reference') {
      const {fileUri, mimeType} = stored;
      if (!isArtifactUri(fileUri)) {
        return {fileData: {fileUri, mimeType}};
      }

      const parsedUri = parseArtifactReference({
        appName: request.appName,
        userId: request.userId,
        sessionId: request.sessionId,
        fileUri,
      });
      assertArtifactReferenceDepth(depth, fileUri);

      return this.loadArtifactAtDepth(
        {
          appName: parsedUri.appName,
          userId: parsedUri.userId,
          sessionId: parsedUri.sessionId ?? request.sessionId,
          filename: parsedUri.filename,
          version: parsedUri.version,
        },
        depth + 1,
      );
    }

    if (stored.displayName) {
      return {
        inlineData: {
          data: stored.data.toString('base64'),
          mimeType: stored.contentType,
          displayName: stored.displayName,
        },
      };
    }

    if (stored.isText) {
      return createPartFromText(stored.data.toString('utf-8'));
    }

    return createPartFromBase64(
      stored.data.toString('base64'),
      stored.contentType!,
    );
  }

  private async readStoredArtifact(
    request: LoadArtifactRequest,
  ): Promise<StoredArtifact | undefined> {
    try {
      let version = request.version;
      if (version === undefined) {
        const versions = await this.listVersions(request);

        if (versions.length === 0) {
          return undefined;
        }

        version = Math.max(...versions);
      }

      const file = this.bucket.file(
        getFileName({
          ...request,
          version,
        }),
      );
      const [metadata] = await file.getMetadata();
      const customMeta = (metadata.metadata ?? {}) as Record<string, unknown>;
      const fileUri = customMeta[GCS_FILE_URI_METADATA_KEY] as
        | string
        | undefined;

      if (fileUri) {
        return {
          kind: 'reference',
          fileUri,
          mimeType:
            (customMeta[GCS_FILE_MIME_TYPE_METADATA_KEY] as
              | string
              | undefined) ??
            metadata.contentType ??
            undefined,
        };
      }

      const [rawDataBuffer] = await file.download();

      return {
        kind: 'content',
        data: rawDataBuffer,
        contentType: metadata.contentType,
        displayName: customMeta[GCS_DISPLAY_NAME_METADATA_KEY] as
          | string
          | undefined,
        isText:
          customMeta[GCS_IS_TEXT_METADATA_KEY] === 'true' ||
          metadata.contentType === 'text/plain',
      };
    } catch (e) {
      logger.warn(
        `[GcsArtifactService] loadArtifact: Failed to load artifact ${request.filename}`,
        e,
      );
      return undefined;
    }
  }

  async listArtifactKeys(request: ListArtifactKeysRequest): Promise<string[]> {
    validatePathSegment(request.appName, 'appName');
    validatePathSegment(request.userId, 'userId');
    validatePathSegment(request.sessionId, 'sessionId');

    const sessionPrefix = `${request.appName}/${request.userId}/${request.sessionId}/`;
    const usernamePrefix = `${request.appName}/${request.userId}/user/`;
    const [[sessionFiles], [userSessionFiles]] = await Promise.all([
      this.bucket.getFiles({prefix: sessionPrefix}),
      this.bucket.getFiles({prefix: usernamePrefix}),
    ]);

    return [
      ...extractArtifactKeys(sessionFiles, sessionPrefix),
      ...extractArtifactKeys(userSessionFiles, usernamePrefix, 'user:'),
    ].sort((a, b) => a.localeCompare(b));
  }

  async deleteArtifact(request: DeleteArtifactRequest): Promise<void> {
    const versions = await this.listVersions(request);

    await Promise.all(
      versions.map((version) => {
        const file = this.bucket.file(
          getFileName({
            ...request,
            version,
          }),
        );

        return file.delete();
      }),
    );

    return;
  }

  async listVersions(request: ListVersionsRequest): Promise<number[]> {
    const prefix = getFileName(request);
    // We need to add a trailing slash to prefix to ensure we only get children
    const searchPrefix = prefix + '/';
    const [files] = await this.bucket.getFiles({prefix: searchPrefix});
    const versions = [];
    for (const file of files) {
      const version = file.name.split('/').pop()!;
      const v = parseInt(version, 10);
      if (!isNaN(v)) {
        versions.push(v);
      }
    }

    return versions.sort((a, b) => a - b);
  }

  async listArtifactVersions(
    request: ListVersionsRequest,
  ): Promise<ArtifactVersion[]> {
    const versions = await this.listVersions(request);
    const artifactVersions: ArtifactVersion[] = [];

    for (const version of versions) {
      const artifactVersion = await this.getArtifactVersion({
        ...request,
        version,
      });

      if (artifactVersion) {
        artifactVersions.push(artifactVersion);
      }
    }

    return artifactVersions;
  }

  async getArtifactVersion(
    request: LoadArtifactRequest,
  ): Promise<ArtifactVersion | undefined> {
    try {
      let version = request.version;
      if (version === undefined) {
        const versions = await this.listVersions(request);
        if (versions.length === 0) {
          return undefined;
        }
        version = Math.max(...versions);
      }

      const file = this.bucket.file(
        getFileName({
          ...request,
          version,
        }),
      );

      const [metadata] = await file.getMetadata();

      return {
        version,
        mimeType: metadata.contentType,
        customMetadata: metadata.metadata as Record<string, unknown>,
        canonicalUri: file.publicUrl(),
      };
    } catch (e) {
      logger.warn(
        `[GcsArtifactService] getArtifactVersion: Failed to get artifact version for userId: ${request.userId} sessionId: ${request.sessionId} filename: ${request.filename} version: ${request.version}`,
        e,
      );
      return undefined;
    }
  }
}

/**
 * Rejects identifiers that would alter the blob name they are built into.
 *
 * @param request The request whose scope identifiers are about to be used.
 */
function validateBlobPathSegments({
  appName,
  userId,
  sessionId,
  filename,
}: LoadArtifactRequest): void {
  validatePathSegment(appName, 'appName');
  validatePathSegment(userId, 'userId');

  if (!filename.startsWith(USER_NAMESPACE_PREFIX)) {
    validatePathSegment(sessionId, 'sessionId');
  }
}

function getFileName(request: LoadArtifactRequest): string {
  validateBlobPathSegments(request);

  const {appName, userId, sessionId, filename, version} = request;
  const isUser = filename.startsWith(USER_NAMESPACE_PREFIX);
  const cleanFilename = isUser
    ? filename.substring(USER_NAMESPACE_PREFIX.length)
    : filename;

  const prefix = isUser
    ? `${appName}/${userId}/user/${cleanFilename}`
    : `${appName}/${userId}/${sessionId}/${cleanFilename}`;

  return version !== undefined ? `${prefix}/${version}` : prefix;
}

function extractArtifactKeys(
  files: File[],
  fileNamePrefix: string,
  keyPrefix: string = '',
): string[] {
  const keys = new Set<string>();
  for (const file of files) {
    if (!file.name.startsWith(fileNamePrefix)) {
      continue;
    }

    const relative = file.name.substring(fileNamePrefix.length);
    const name = getFileNameFromPath(relative);

    keys.add(`${keyPrefix}${name}`);
  }

  return [...keys];
}

function getFileNameFromPath(filePath: string): string {
  const parts = filePath.split('/');
  if (parts.length < 2) {
    return filePath;
  }

  return parts.slice(0, -1).join('/');
}
