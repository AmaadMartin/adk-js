/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type {
  Bucket,
  File,
  FileMetadata,
  GetSignedUrlConfig,
  StorageOptions,
} from '@google-cloud/storage';
import {createPartFromBase64, createPartFromText, Part} from '@google/genai';
import {InputValidationError} from '../errors/input_validation_error.js';
import {logger} from '../utils/logger.js';
import {loadOptionalPeer} from '../utils/optional_peer.js';

import {
  ARTIFACT_URI_SCHEME,
  isArtifactRef,
  parseArtifactUri,
  validateArtifactReferenceScope,
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
const VERSION_PATTERN = /^[0-9]+$/;
const NOT_FOUND_STATUS = 404;
const AUTHENTICATED_URL_HOST = 'https://storage.cloud.google.com';
const DEFAULT_SIGNED_URL_TTL_MS = 60 * 60 * 1000;
const MAX_ARTIFACT_REFERENCE_DEPTH = 5;

/**
 * Identifies one artifact. The session is optional because a `user:` filename
 * is scoped to the user, and because an artifact reference may name a
 * user-scoped artifact.
 */
interface ArtifactKey {
  appName: string;
  userId: string;
  sessionId?: string;
  filename: string;
}

/** An {@link ArtifactKey} with an optional version, defaulting to the latest. */
interface VersionedArtifactKey extends ArtifactKey {
  version?: number;
}

/** What an artifact resolves to once its references are followed. */
type ResolvedArtifact =
  | {
      kind: 'object';
      file: File;
      objectName: string;
      metadata: FileMetadata;
      customMetadata: Record<string, unknown>;
    }
  | {kind: 'reference'; fileUri: string; mimeType?: string};

/** The parameters for {@link GcsArtifactService.getSignedUrl}. */
export interface GetSignedUrlRequest extends LoadArtifactRequest {
  /**
   * Options for the storage client, merged over the defaults: a `'read'`
   * action, and an expiry one hour from now.
   */
  signingOptions?: Partial<GetSignedUrlConfig>;
}

export class GcsArtifactService implements BaseArtifactService {
  private readonly bucketName: string;
  private readonly storageOptions?: StorageOptions;
  private bucketPromise?: Promise<Bucket>;

  constructor(bucket: string, options?: StorageOptions) {
    this.bucketName = bucket;
    this.storageOptions = options;
  }

  /**
   * Resolves the GCS bucket handle, loading the `@google-cloud/storage`
   * optional peer on first use.
   */
  private getBucket(): Promise<Bucket> {
    this.bucketPromise ??= loadOptionalPeer(
      {packageName: '@google-cloud/storage', feature: 'GcsArtifactService'},
      () => import('@google-cloud/storage'),
    ).then(({Storage}) =>
      new Storage(this.storageOptions).bucket(this.bucketName),
    );
    return this.bucketPromise;
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
    const bucket = await this.getBucket();
    const file = bucket.file(getBlobName(request, version));

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
        throw new InputValidationError(
          'Artifact fileData must have a fileUri.',
        );
      }
      if (isArtifactRef(request.artifact)) {
        const parsedUri = parseArtifactUri(fileUri);
        if (!parsedUri) {
          throw new InputValidationError(
            `Invalid artifact reference URI: ${fileUri}`,
          );
        }
        validateArtifactReferenceScope({
          appName: request.appName,
          userId: request.userId,
          sessionId: request.sessionId,
          parsedUri,
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
    try {
      const resolved = await this.resolveArtifact(request);
      if (!resolved) {
        return undefined;
      }

      if (resolved.kind === 'reference') {
        return {
          fileData: {fileUri: resolved.fileUri, mimeType: resolved.mimeType},
        };
      }

      const {file, metadata, customMetadata} = resolved;
      const [rawDataBuffer] = await file.download();

      const displayName = customMetadata[GCS_DISPLAY_NAME_METADATA_KEY] as
        | string
        | undefined;
      if (displayName) {
        return {
          inlineData: {
            data: rawDataBuffer.toString('base64'),
            mimeType: metadata.contentType,
            displayName,
          },
        };
      }

      if (
        customMetadata[GCS_IS_TEXT_METADATA_KEY] === 'true' ||
        metadata.contentType === 'text/plain'
      ) {
        return createPartFromText(rawDataBuffer.toString('utf-8'));
      }

      return createPartFromBase64(
        rawDataBuffer.toString('base64'),
        metadata.contentType!,
      );
    } catch (e: unknown) {
      if (e instanceof InputValidationError) {
        throw e;
      }
      logger.warn(
        `[GcsArtifactService] loadArtifact: Failed to load artifact ${request.filename}`,
        e,
      );
      return undefined;
    }
  }

  async listArtifactKeys(request: ListArtifactKeysRequest): Promise<string[]> {
    validatePathSegment(request.appName, 'app_name');
    validatePathSegment(request.userId, 'user_id');
    validatePathSegment(request.sessionId, 'session_id');

    const sessionPrefix = `${request.appName}/${request.userId}/${request.sessionId}/`;
    const usernamePrefix = `${request.appName}/${request.userId}/user/`;
    const bucket = await this.getBucket();
    const [[sessionFiles], [userSessionFiles]] = await Promise.all([
      bucket.getFiles({prefix: sessionPrefix}),
      bucket.getFiles({prefix: usernamePrefix}),
    ]);

    return [
      ...extractArtifactKeys(sessionFiles, sessionPrefix),
      ...extractArtifactKeys(
        userSessionFiles,
        usernamePrefix,
        USER_NAMESPACE_PREFIX,
      ),
    ].sort((a, b) => a.localeCompare(b));
  }

  async deleteArtifact(request: DeleteArtifactRequest): Promise<void> {
    const versions = await this.listVersions(request);
    const bucket = await this.getBucket();

    await Promise.all(
      versions.map((version) =>
        bucket.file(getBlobName(request, version)).delete(),
      ),
    );

    return;
  }

  async listVersions(request: ListVersionsRequest): Promise<number[]> {
    return this.listVersionsForKey(request);
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
      const version = await this.resolveVersion(request);
      if (version === undefined) {
        return undefined;
      }

      const objectName = getBlobName(request, version);
      const file = (await this.getBucket()).file(objectName);
      const metadata = await getMetadataIfExists(file);
      if (!metadata) {
        return undefined;
      }

      return {
        version,
        mimeType: metadata.contentType,
        customMetadata: metadata.metadata as Record<string, unknown>,
        canonicalUri: `gs://${this.bucketName}/${objectName}`,
        createTime: toEpochSeconds(metadata.timeCreated),
      };
    } catch (e: unknown) {
      if (e instanceof InputValidationError) {
        throw e;
      }
      logger.warn(
        `[GcsArtifactService] getArtifactVersion: Failed to get artifact version for userId: ${request.userId} sessionId: ${request.sessionId} filename: ${request.filename} version: ${request.version}`,
        e,
      );
      return undefined;
    }
  }

  /**
   * Generates a browser URL for an artifact.
   *
   * The URL requires the reader to be signed in to a Google Account that has
   * read permission on the object.
   *
   * @param request The artifact to link to. Without a version, the latest
   *     version is used.
   * @return The URL, or undefined when the artifact does not exist or holds a
   *     pointer to a file this service does not own.
   */
  async getAuthenticatedUrl(
    request: LoadArtifactRequest,
  ): Promise<string | undefined> {
    const resolved = await this.resolveArtifact(request);
    if (resolved?.kind !== 'object') {
      return undefined;
    }
    const objectName = encodeObjectName(resolved.objectName);
    return `${AUTHENTICATED_URL_HOST}/${this.bucketName}/${objectName}`;
  }

  /**
   * Generates a time-limited signed URL for an artifact.
   *
   * The URL carries its own authorization, so treat it as a bearer token for
   * the object until it expires. Signing needs credentials that can sign, and
   * the storage client reports a signing failure.
   *
   * @param request The artifact to link to, and the signing options.
   * @return The signed URL, or undefined when the artifact does not exist or
   *     holds a pointer to a file this service does not own.
   */
  async getSignedUrl(
    request: GetSignedUrlRequest,
  ): Promise<string | undefined> {
    const resolved = await this.resolveArtifact(request);
    if (resolved?.kind !== 'object') {
      return undefined;
    }

    const [url] = await resolved.file.getSignedUrl({
      action: 'read',
      expires: Date.now() + DEFAULT_SIGNED_URL_TTL_MS,
      ...request.signingOptions,
    });
    return url;
  }

  private async listVersionsForKey(key: ArtifactKey): Promise<number[]> {
    // We need to add a trailing slash to prefix to ensure we only get children
    const searchPrefix = `${getBlobPrefix(key)}/`;
    const bucket = await this.getBucket();
    const [files] = await bucket.getFiles({prefix: searchPrefix});
    const versions: number[] = [];
    for (const file of files) {
      const version = parseVersion(file.name, searchPrefix);
      if (version !== undefined) {
        versions.push(version);
      }
    }

    return versions.sort((a, b) => a - b);
  }

  /**
   * Resolves the version to read, defaulting to the latest one.
   *
   * @return The version, or undefined when the artifact has no version.
   */
  private async resolveVersion(
    key: VersionedArtifactKey,
  ): Promise<number | undefined> {
    if (key.version !== undefined) {
      return key.version;
    }
    const versions = await this.listVersionsForKey(key);
    return versions.length > 0 ? Math.max(...versions) : undefined;
  }

  /**
   * Reads the object that holds an artifact, following `artifact://`
   * references until a stored object is reached.
   *
   * @param key The artifact to read.
   * @param depth How many further references may be followed.
   * @return The object, the pointer it holds to a file this service does not
   *     own, or undefined when the object does not exist.
   * @throws InputValidationError When a reference is malformed, leaves the
   *     caller's scope, or nests deeper than the depth limit.
   */
  private async resolveArtifact(
    key: VersionedArtifactKey,
    depth: number = MAX_ARTIFACT_REFERENCE_DEPTH,
  ): Promise<ResolvedArtifact | undefined> {
    const version = await this.resolveVersion(key);
    if (version === undefined) {
      return undefined;
    }

    const objectName = getBlobName(key, version);
    const file = (await this.getBucket()).file(objectName);
    const metadata = await getMetadataIfExists(file);
    if (!metadata) {
      return undefined;
    }

    const customMetadata = (metadata.metadata ?? {}) as Record<string, unknown>;
    const fileUri = customMetadata[GCS_FILE_URI_METADATA_KEY] as
      | string
      | undefined;

    if (!fileUri) {
      return {kind: 'object', file, objectName, metadata, customMetadata};
    }

    if (!fileUri.startsWith(ARTIFACT_URI_SCHEME)) {
      const mimeType =
        (customMetadata[GCS_FILE_MIME_TYPE_METADATA_KEY] as
          | string
          | undefined) ??
        metadata.contentType ??
        undefined;
      return {kind: 'reference', fileUri, mimeType};
    }

    if (depth <= 0) {
      throw new InputValidationError(
        `Exceeded maximum recursion depth resolving artifact reference: ${fileUri}`,
      );
    }

    const parsedUri = parseArtifactUri(fileUri);
    if (!parsedUri) {
      throw new InputValidationError(
        `Invalid artifact reference URI: ${fileUri}`,
      );
    }
    validateArtifactReferenceScope({
      appName: key.appName,
      userId: key.userId,
      sessionId: key.sessionId,
      parsedUri,
    });

    return this.resolveArtifact(parsedUri, depth - 1);
  }
}

/**
 * Builds the object name prefix shared by every version of an artifact.
 *
 * @throws InputValidationError When an identifier could alter the object name,
 *     or when a session-scoped artifact has no session.
 */
function getBlobPrefix({
  appName,
  userId,
  sessionId,
  filename,
}: ArtifactKey): string {
  validatePathSegment(appName, 'app_name');
  validatePathSegment(userId, 'user_id');

  if (filename.startsWith(USER_NAMESPACE_PREFIX)) {
    const cleanFilename = filename.substring(USER_NAMESPACE_PREFIX.length);
    return `${appName}/${userId}/user/${cleanFilename}`;
  }

  if (sessionId === undefined) {
    throw new InputValidationError(
      'Session ID must be provided for session-scoped artifacts.',
    );
  }
  validatePathSegment(sessionId, 'session_id');
  return `${appName}/${userId}/${sessionId}/${filename}`;
}

function getBlobName(key: ArtifactKey, version: number): string {
  return `${getBlobPrefix(key)}/${version}`;
}

/**
 * Extracts the version an object holds, given the prefix it was listed under.
 *
 * GCS has a flat namespace, so the prefix of an artifact is also the prefix of
 * every artifact nested under it: listing `a/` to find the versions of `a`
 * also returns `a/b/3`, which is version 3 of the distinct artifact `a/b`.
 *
 * @return The version, or undefined when the object holds no version of the
 *     artifact the prefix denotes.
 */
function parseVersion(objectName: string, prefix: string): number | undefined {
  const suffix = objectName.substring(prefix.length);
  if (suffix.includes('/')) {
    return undefined;
  }
  if (!VERSION_PATTERN.test(suffix)) {
    logger.warn(
      `[GcsArtifactService] Skipping object ${objectName} because it does not end with a version number.`,
    );
    return undefined;
  }
  return Number(suffix);
}

/**
 * Reads the metadata of an object.
 *
 * The storage client rejects with a 404 for an object that does not exist,
 * which every read path here reports as a missing artifact rather than as a
 * failure. Any other error still escapes.
 *
 * @return The metadata, or undefined when the object does not exist.
 */
async function getMetadataIfExists(
  file: File,
): Promise<FileMetadata | undefined> {
  try {
    const [metadata] = await file.getMetadata();
    return metadata;
  } catch (e: unknown) {
    if (isNotFoundError(e)) {
      return undefined;
    }
    throw e;
  }
}

function isNotFoundError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === NOT_FOUND_STATUS
  );
}

/** Percent-encodes an object name for a URL path, keeping the separators. */
function encodeObjectName(objectName: string): string {
  return objectName
    .split('/')
    .map((segment) =>
      encodeURIComponent(segment).replace(
        /[!'()*]/g,
        (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
      ),
    )
    .join('/');
}

/**
 * Converts an RFC 3339 timestamp to Unix seconds.
 *
 * @return The timestamp in seconds, or undefined when there is none to read.
 */
function toEpochSeconds(timestamp?: string): number | undefined {
  if (timestamp === undefined) {
    return undefined;
  }
  const milliseconds = Date.parse(timestamp);
  return Number.isNaN(milliseconds) ? undefined : milliseconds / 1000;
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
