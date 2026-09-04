/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Part} from '@google/genai';
import * as fs from 'fs/promises';
import type {Dirent} from 'node:fs';
import * as path from 'path';
import {fileURLToPath, pathToFileURL} from 'url';

import {InputValidationError} from '../errors/input_validation_error.js';
import {isErrnoCode} from '../utils/error_utils.js';
import {isInsideDir, pathExists} from '../utils/file_utils.js';
import {logger} from '../utils/logger.js';

import {
  ArtifactVersion,
  BaseArtifactService,
  DeleteArtifactRequest,
  ListArtifactKeysRequest,
  ListVersionsRequest,
  LoadArtifactRequest,
  SaveArtifactRequest,
} from './base_artifact_service.js';

const USER_NAMESPACE_PREFIX = 'user:';

/**
 * Name of the per-version metadata document.
 *
 * A payload is stored beside it under the artifact directory's own name, so an
 * artifact whose directory is named `metadata.json` would have its payload
 * written over the metadata document. Callers may not use that name.
 */
const METADATA_FILENAME = 'metadata.json';

/** Directory that holds the versions of one artifact. */
const VERSIONS_DIRNAME = 'versions';

const WINDOWS_DRIVE_RE = /^[A-Za-z]:/;

/**
 * Metadata for a file artifact version.
 */
interface FileArtifactVersion extends ArtifactVersion {
  fileName?: string;
  fileUri?: string;
  displayName?: string;
}

/** A version number reserved for one save, with its staging and final paths. */
interface VersionReservation {
  version: number;
  stagingDir: string;
  versionDir: string;
}

/**
 * Service for managing artifacts stored on the local filesystem.
 *
 * Stores filesystem-backed artifacts beneath a configurable root directory.
 *
 * Storage layout matches the cloud and in-memory services:
 * root/
 * └── apps/
 *     └── {appName}/
 *         └── users/
 *             └── {userId}/
 *                 ├── sessions/
 *                 │   └── {sessionId}/
 *                 │       └── artifacts/
 *                 │           └── {artifactPath}/  // derived from filename
 *                 │               └── versions/
 *                 │                   ├── .{version}.pending/  // in progress
 *                 │                   └── {version}/
 *                 │                       ├── {originalFilename}
 *                 │                       └── metadata.json
 *                 └── artifacts/
 *                     └── {artifactPath}/...
 *
 * Releases that predate the `apps/{appName}` level wrote the same tree directly
 * under `root/users`, which records no app name. A root can be shared by
 * several apps, so that tree cannot be attributed to one of them and is never
 * read from or deleted.
 *
 * Artifact paths are derived from the provided filenames: separators create
 * nested directories, and path traversal is rejected to keep the layout
 * portable across filesystems. `{artifactPath}` therefore mirrors the
 * sanitized, scope-relative path derived from each filename.
 *
 * A save stages into `.{version}.pending` and publishes it with a single
 * rename, so readers only ever observe complete versions. A staging directory
 * left behind by a killed save is never read, but it keeps its version number
 * reserved, so published versions are not guaranteed to be contiguous.
 */
export class FileArtifactService implements BaseArtifactService {
  private readonly rootDir: string;

  constructor(rootDirOrUri: string) {
    try {
      const rootDir = rootDirOrUri.startsWith('file://')
        ? fileURLToPath(rootDirOrUri)
        : rootDirOrUri;
      this.rootDir = path.resolve(rootDir);
    } catch (e) {
      throw new Error(`Invalid root directory: ${rootDirOrUri}`, {cause: e});
    }
  }

  async saveArtifact({
    appName,
    userId,
    sessionId,
    filename,
    artifact,
    customMetadata,
  }: SaveArtifactRequest): Promise<number> {
    if (!artifact.inlineData && !artifact.text && !artifact.fileData) {
      throw new InputValidationError(
        'Artifact must have either inlineData or text content.',
      );
    }

    const artifactDir = getArtifactDir(
      this.rootDir,
      appName,
      userId,
      sessionId,
      filename,
    );

    // Checked here rather than in `getArtifactDir`, which reads and deletes
    // share: an artifact stored under this name before the name was reserved
    // must stay readable and, above all, deletable.
    if (isReservedArtifactName(getPayloadName(artifactDir))) {
      throw new InputValidationError(
        `Artifact filename ${filename} is reserved: an artifact may not be ` +
          `named ${METADATA_FILENAME} (in any casing) because its payload is ` +
          `stored under the artifact's own name and would overwrite the ` +
          `metadata document.`,
      );
    }

    await fs.mkdir(artifactDir, {recursive: true});
    const {version, stagingDir, versionDir} =
      await reserveVersionDir(artifactDir);

    const contentPath = path.join(stagingDir, getPayloadName(artifactDir));

    // A version directory is only ever observed complete or not at all. A
    // partially written version -- payload present, metadata missing or
    // truncated -- is indistinguishable from a valid one on the read path, so
    // any failure discards the whole staging directory instead of publishing
    // it.
    try {
      let mimeType: string | undefined;
      let fileUri: string | undefined;
      let displayName: string | undefined;

      if (artifact.inlineData) {
        const data = artifact.inlineData.data;
        if (data === undefined) {
          throw new InputValidationError(
            'Artifact inlineData must contain data.',
          );
        }
        // GenAI SDK Part data is in Base64 format. See https://googleapis.github.io/js-genai/release_docs/interfaces/types.Part.html
        await fs.writeFile(contentPath, Buffer.from(data, 'base64'));
        mimeType = artifact.inlineData.mimeType || 'application/octet-stream';
        displayName = artifact.inlineData.displayName;
      } else if (artifact.text !== undefined) {
        await fs.writeFile(contentPath, artifact.text, 'utf-8');
      } else {
        fileUri = artifact.fileData!.fileUri;
        if (!fileUri) {
          throw new InputValidationError(
            'Artifact fileData must have a fileUri.',
          );
        }
        mimeType = artifact.fileData!.mimeType;
      }

      const metadata: FileArtifactVersion = {
        fileName: filename,
        mimeType,
        fileUri,
        displayName,
        version,
        canonicalUri: getCanonicalUri(artifactDir, version),
        customMetadata: customMetadata ?? {},
      };
      await writeMetadata(path.join(stagingDir, METADATA_FILENAME), metadata);
      await fs.rename(stagingDir, versionDir);
    } catch (e) {
      await fs.rm(stagingDir, {recursive: true, force: true});
      throw e;
    }

    logger.debug(
      `[FileArtifactService] saveArtifact: Saved ${filename} version ${version} to ${versionDir}`,
    );
    return version;
  }

  async loadArtifact({
    appName,
    userId,
    sessionId,
    filename,
    version,
  }: LoadArtifactRequest): Promise<Part | undefined> {
    const artifactDir = getArtifactDir(
      this.rootDir,
      appName,
      userId,
      sessionId,
      filename,
    );

    const versionToLoad = await resolveVersion(artifactDir, version);
    if (versionToLoad === undefined) {
      return undefined;
    }

    const metadata = await readMetadata(
      getMetadataPath(artifactDir, versionToLoad),
    );

    if (metadata?.fileUri) {
      return {
        fileData: {fileUri: metadata.fileUri, mimeType: metadata.mimeType},
      };
    }

    // The payload location is derived exclusively from the storage layout. It
    // must never be taken from the metadata document: that document lives in
    // the artifact tree and is therefore attacker-influenced input, so
    // honouring a `canonicalUri` from it would be an arbitrary file read.
    const contentPath = getPayloadPath(artifactDir, versionToLoad);

    // Read without a preceding `exists()` check. A concurrent `deleteArtifact`
    // can unlink the payload between the check and the read, and reacting to
    // that gap is what previously reached the metadata-supplied path.
    const payload = await readPayload(contentPath);
    if (payload === undefined) {
      logger.warn(
        `[FileArtifactService] loadArtifact: Artifact ${filename} missing at ${contentPath}`,
      );
      return undefined;
    }

    if (metadata?.mimeType) {
      return {
        inlineData: {
          mimeType: metadata.mimeType,
          data: payload.toString('base64'),
          displayName: metadata.displayName,
        },
      };
    }
    return {text: payload.toString('utf-8')};
  }

  async listArtifactKeys({
    appName,
    userId,
    sessionId,
  }: ListArtifactKeysRequest): Promise<string[]> {
    const filenames: Set<string> = new Set();
    const baseRoot = getUserRoot(getAppRoot(this.rootDir, appName), userId);

    const sessionRoot = getSessionArtifactsDir(baseRoot, sessionId);
    for await (const artifactDir of iterateArtifactDirs(sessionRoot)) {
      filenames.add(await getArtifactKey(artifactDir, sessionRoot, ''));
    }

    const artifactsRoot = getUserArtifactsDir(baseRoot);
    for await (const artifactDir of iterateArtifactDirs(artifactsRoot)) {
      filenames.add(
        await getArtifactKey(artifactDir, artifactsRoot, USER_NAMESPACE_PREFIX),
      );
    }

    return Array.from(filenames).sort();
  }

  async deleteArtifact({
    appName,
    userId,
    sessionId,
    filename,
  }: DeleteArtifactRequest): Promise<void> {
    const scopeRoot = getScopeRoot(
      this.rootDir,
      appName,
      userId,
      sessionId,
      filename,
    );
    const artifactDir = resolveScopedArtifactPath(scopeRoot, filename);
    const versionsDir = getVersionsDir(artifactDir);
    if (!(await pathExists(versionsDir))) {
      return;
    }

    // Only this artifact's own versions go. Its directory may also be the
    // parent of a nested artifact ("doc" vs "doc/nested"), so it is pruned
    // separately and only once nothing is left under it.
    await fs.rm(versionsDir, {recursive: true, force: true});
    await pruneEmptyDirs(artifactDir, scopeRoot);
    logger.debug(
      `[FileArtifactService] deleteArtifact: Deleted ${filename} at ${artifactDir}`,
    );
  }

  async listVersions({
    appName,
    userId,
    sessionId,
    filename,
  }: ListVersionsRequest): Promise<number[]> {
    const artifactDir = getArtifactDir(
      this.rootDir,
      appName,
      userId,
      sessionId,
      filename,
    );
    return listVersionsOnDisk(artifactDir);
  }

  async listArtifactVersions({
    appName,
    userId,
    sessionId,
    filename,
  }: ListVersionsRequest): Promise<ArtifactVersion[]> {
    const artifactDir = getArtifactDir(
      this.rootDir,
      appName,
      userId,
      sessionId,
      filename,
    );
    const versions = await listVersionsOnDisk(artifactDir);
    const artifactVersions: ArtifactVersion[] = [];
    for (const version of versions) {
      const metadata = await readMetadata(
        getMetadataPath(artifactDir, version),
      );
      artifactVersions.push(
        buildArtifactVersion(artifactDir, version, metadata),
      );
    }
    return artifactVersions;
  }

  async getArtifactVersion({
    appName,
    userId,
    sessionId,
    filename,
    version,
  }: LoadArtifactRequest): Promise<ArtifactVersion | undefined> {
    const artifactDir = getArtifactDir(
      this.rootDir,
      appName,
      userId,
      sessionId,
      filename,
    );
    const versionToRead = await resolveVersion(artifactDir, version);
    if (versionToRead === undefined) {
      return undefined;
    }
    const metadata = await readMetadata(
      getMetadataPath(artifactDir, versionToRead),
    );
    return buildArtifactVersion(artifactDir, versionToRead, metadata);
  }
}

const SAFE_SEGMENT_RE = /^[a-zA-Z0-9_@-][a-zA-Z0-9_.@-]{0,255}$/;

export function assertSafeSegment(value: string, label: string): void {
  if (!value || !SAFE_SEGMENT_RE.test(value)) {
    throw new InputValidationError(
      `[FileArtifactService] Invalid ${label}: value contains disallowed characters.`,
    );
  }
}

export function assertInsideRoot(
  resolvedPath: string,
  rootDir: string,
  label: string,
): void {
  const root = path.resolve(rootDir);
  const resolved = path.resolve(resolvedPath);
  if (!isInsideDir(resolved, root)) {
    throw new InputValidationError(
      `[FileArtifactService] ${label} escapes storage root. Resolved: ${resolved}, Root: ${root}`,
    );
  }
}

/**
 * Gets the app-scoped root that holds every user's artifacts for one app.
 *
 * @param rootDir The service root directory.
 * @param appName The application name.
 * @returns The app root directory path.
 */
export function getAppRoot(rootDir: string, appName: string): string {
  assertSafeSegment(appName, 'appName');
  const result = path.join(rootDir, 'apps', appName);
  assertInsideRoot(result, rootDir, 'appRoot');
  return result;
}

/**
 * Gets the directory holding one user's artifacts within an app root.
 *
 * @param baseRoot The app root directory, as returned by {@link getAppRoot}.
 * @param userId The user ID.
 * @returns The user root directory path.
 */
export function getUserRoot(baseRoot: string, userId: string): string {
  assertSafeSegment(userId, 'userId');
  const result = path.join(baseRoot, 'users', userId);
  assertInsideRoot(result, baseRoot, 'userRoot');
  return result;
}

function isUserScoped(
  sessionId: string | undefined,
  filename: string,
): boolean {
  return !sessionId || filename.startsWith(USER_NAMESPACE_PREFIX);
}

function getUserArtifactsDir(userRoot: string): string {
  return path.join(userRoot, 'artifacts');
}

export function getSessionArtifactsDir(
  baseRoot: string,
  sessionId: string,
): string {
  assertSafeSegment(sessionId, 'sessionId');
  const result = path.join(baseRoot, 'sessions', sessionId, 'artifacts');
  assertInsideRoot(result, baseRoot, 'sessionArtifactsDir');
  return result;
}

function getVersionsDir(artifactDir: string): string {
  return path.join(artifactDir, VERSIONS_DIRNAME);
}

function getVersionDir(artifactDir: string, version: number): string {
  return path.join(getVersionsDir(artifactDir), version.toString());
}

function getMetadataPath(artifactDir: string, version: number): string {
  return path.join(getVersionDir(artifactDir, version), METADATA_FILENAME);
}

/**
 * Returns the name a payload is stored under.
 *
 * A version directory holds the payload beside the metadata document, so the
 * payload takes the artifact directory's own name. That rule is why
 * {@link isReservedArtifactName} exists.
 *
 * @param artifactDir The artifact directory.
 * @returns The payload filename.
 */
function getPayloadName(artifactDir: string): string {
  return path.basename(artifactDir);
}

function getPayloadPath(artifactDir: string, version: number): string {
  return path.join(
    getVersionDir(artifactDir, version),
    getPayloadName(artifactDir),
  );
}

/**
 * Checks whether an artifact directory name collides with the metadata
 * document.
 *
 * Compared caselessly because the collision is decided by the filesystem, and
 * the case-insensitive ones ADK supports (APFS, NTFS) resolve `Metadata.json`
 * and `metadata.json` to the same file.
 *
 * @param name The final path segment of the artifact directory.
 * @returns True if the name is reserved for internal use.
 */
function isReservedArtifactName(name: string): boolean {
  return name.toLowerCase() === METADATA_FILENAME;
}

/** Checks POSIX and Windows rooted or drive-qualified path forms. */
function isRootedOrDriveQualified(value: string): boolean {
  return (
    value.startsWith('/') ||
    value.startsWith('\\') ||
    WINDOWS_DRIVE_RE.test(value)
  );
}

/** Checks parent traversal using either platform's separators. */
function hasParentReference(value: string): boolean {
  return value.split(/[/\\]/).includes('..');
}

/**
 * Gets the directory that stores an artifact within a scope.
 *
 * Filenames that are rooted, drive-qualified, or that contain a parent
 * reference are rejected, including a parent reference that would resolve back
 * inside the scope root.
 *
 * The containment check is lexical: it resolves the candidate and compares
 * strings. It guards against traversal in the supplied name; it is not a
 * sandbox, and it does not survive symlinks, hardlinks, bind mounts, or a
 * change to the tree between this check and the later filesystem call.
 *
 * @param scopeRoot Directory that defines the storage scope.
 * @param filename Caller-supplied artifact name.
 * @returns The absolute artifact directory path.
 */
function resolveScopedArtifactPath(
  scopeRoot: string,
  filename: string,
): string {
  let cleanFilename = filename;
  if (cleanFilename.startsWith(USER_NAMESPACE_PREFIX)) {
    cleanFilename = cleanFilename.substring(USER_NAMESPACE_PREFIX.length);
  }
  cleanFilename = cleanFilename.trim();

  if (isRootedOrDriveQualified(cleanFilename)) {
    throw new InputValidationError(
      `Rooted or drive-qualified artifact filename ${filename} is not permitted; provide a path relative to the storage scope.`,
    );
  }

  const scopeRootResolved = path.resolve(scopeRoot);
  const artifactDir = path.resolve(scopeRootResolved, cleanFilename);
  if (!isInsideDir(artifactDir, scopeRootResolved)) {
    throw new InputValidationError(
      `Artifact filename ${filename} escapes storage directory.`,
    );
  }
  // Rejected even when the name resolves back inside the scope root, so one
  // artifact cannot be addressed under two different names.
  if (hasParentReference(cleanFilename)) {
    throw new InputValidationError(
      `Artifact filename ${filename} must not contain parent traversal.`,
    );
  }
  if (artifactDir === scopeRootResolved) {
    return path.join(scopeRootResolved, 'artifact');
  }

  return artifactDir;
}

/**
 * Gets the directory that represents the artifact scope.
 *
 * @param rootDir The root directory.
 * @param appName The application name.
 * @param userId The user ID.
 * @param sessionId The session ID.
 * @param filename The filename.
 * @returns The scope root directory path.
 */
function getScopeRoot(
  rootDir: string,
  appName: string,
  userId: string,
  sessionId: string,
  filename: string,
): string {
  const baseRoot = getUserRoot(getAppRoot(rootDir, appName), userId);
  return isUserScoped(sessionId, filename)
    ? getUserArtifactsDir(baseRoot)
    : getSessionArtifactsDir(baseRoot, sessionId);
}

/**
 * Gets the artifact directory full path for a given set of artifact keys.
 *
 * @param rootDir The root directory.
 * @param appName The application name.
 * @param userId The user ID.
 * @param sessionId The session ID.
 * @param filename The filename.
 * @returns The artifact directory path.
 */
function getArtifactDir(
  rootDir: string,
  appName: string,
  userId: string,
  sessionId: string,
  filename: string,
): string {
  return resolveScopedArtifactPath(
    getScopeRoot(rootDir, appName, userId, sessionId, filename),
    filename,
  );
}

/**
 * Builds the canonical file:// URI for an artifact payload.
 *
 * Always recomputed from the storage layout rather than read back from the
 * metadata document, so a tampered document cannot dictate the URI handed to
 * callers.
 *
 * @param artifactDir The artifact directory.
 * @param version The version.
 * @returns The canonical URI.
 */
function getCanonicalUri(artifactDir: string, version: number): string {
  return pathToFileURL(getPayloadPath(artifactDir, version)).toString();
}

/**
 * Creates an `ArtifactVersion` from on-disk metadata.
 *
 * @param artifactDir The artifact directory.
 * @param version The version.
 * @param metadata The metadata read from disk, if any.
 * @returns The artifact version.
 */
function buildArtifactVersion(
  artifactDir: string,
  version: number,
  metadata: FileArtifactVersion | undefined,
): ArtifactVersion {
  return {
    version,
    canonicalUri: getCanonicalUri(artifactDir, version),
    customMetadata: {...metadata?.customMetadata},
    mimeType: metadata?.mimeType,
  };
}

/**
 * Removes `leaf` and every parent it leaves empty, stopping at `stopAt`.
 *
 * Filenames may contain "/", so the directory of an artifact doubles as the
 * parent directory of every artifact nested under it: "doc" is stored at
 * `{scope}/doc` and "doc/nested" at `{scope}/doc/nested`. A directory may
 * therefore only be removed once it holds nothing.
 *
 * @param leaf Directory to remove, if it is empty.
 * @param stopAt Scope root. It and everything above it are never removed.
 */
async function pruneEmptyDirs(leaf: string, stopAt: string): Promise<void> {
  const stop = path.resolve(stopAt);
  let current = path.resolve(leaf);
  while (current !== stop && isInsideDir(current, stop)) {
    try {
      // Only succeeds on an empty directory.
      await fs.rmdir(current);
    } catch {
      return;
    }
    current = path.dirname(current);
  }
}

/**
 * Lists the published versions found under an artifact directory.
 *
 * Staging directories are named `.{version}.pending` and never parse as a
 * version number, so an in-progress save is never listed.
 *
 * @param artifactDir The artifact directory.
 * @returns The sorted version numbers.
 */
async function listVersionsOnDisk(artifactDir: string): Promise<number[]> {
  const entries = await readDirEntries(getVersionsDir(artifactDir));
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => parseInt(entry.name, 10))
    .filter((version) => !isNaN(version))
    .sort((a, b) => a - b);
}

/**
 * Resolves the version to read, defaulting to the most recent one.
 *
 * @param artifactDir The artifact directory.
 * @param version The requested version, or undefined for the latest.
 * @returns The version number, or undefined when it is not on disk.
 */
async function resolveVersion(
  artifactDir: string,
  version: number | undefined,
): Promise<number | undefined> {
  const versions = await listVersionsOnDisk(artifactDir);
  if (versions.length === 0) {
    return undefined;
  }
  if (version === undefined) {
    return versions[versions.length - 1];
  }
  return versions.includes(version) ? version : undefined;
}

/**
 * Reserves a version number and returns its staging and final paths.
 *
 * A version number whose staging directory or published directory already
 * exists is skipped rather than reused, so two concurrent saves cannot publish
 * the same version.
 *
 * @param artifactDir The artifact directory.
 * @returns The reservation.
 */
async function reserveVersionDir(
  artifactDir: string,
): Promise<VersionReservation> {
  const versionsDir = getVersionsDir(artifactDir);
  await fs.mkdir(versionsDir, {recursive: true});
  const versions = await listVersionsOnDisk(artifactDir);
  let version = versions.length > 0 ? versions[versions.length - 1] + 1 : 0;

  for (;;) {
    const stagingDir = path.join(versionsDir, `.${version}.pending`);
    try {
      await fs.mkdir(stagingDir);
    } catch (e: unknown) {
      if (!isErrnoCode(e, 'EEXIST')) {
        throw e;
      }
      version += 1;
      continue;
    }

    const versionDir = getVersionDir(artifactDir, version);
    if (!(await pathExists(versionDir))) {
      return {version, stagingDir, versionDir};
    }
    await fs.rmdir(stagingDir);
    version += 1;
  }
}

/**
 * Writes the metadata document for one artifact version.
 *
 * @param metadataPath The path to the metadata file.
 * @param metadata The metadata to write.
 */
async function writeMetadata(
  metadataPath: string,
  metadata: FileArtifactVersion,
): Promise<void> {
  // Serialized before the filesystem is touched: `customMetadata` is caller
  // supplied and can fail to serialize, which must not leave a truncated
  // document behind.
  const serialized = JSON.stringify(metadata);
  await fs.writeFile(metadataPath, serialized, 'utf-8');
}

/**
 * Reads the metadata document for one artifact version.
 *
 * The path is derived from a caller-supplied filename, so it can be made to
 * name a directory rather than a file. That degrades to "no metadata" instead
 * of raising.
 *
 * @param metadataPath The path to the metadata file.
 * @returns The metadata, or undefined when it is missing or malformed.
 */
async function readMetadata(
  metadataPath: string,
): Promise<FileArtifactVersion | undefined> {
  let raw: string;
  try {
    raw = await fs.readFile(metadataPath, 'utf-8');
  } catch (e: unknown) {
    if (!isErrnoCode(e, 'ENOENT')) {
      logger.warn(
        `[FileArtifactService] readMetadata: Unreadable metadata at ${metadataPath}`,
        e,
      );
    }
    return undefined;
  }
  try {
    return JSON.parse(raw) as FileArtifactVersion;
  } catch (e: unknown) {
    logger.warn(
      `[FileArtifactService] readMetadata: Invalid metadata JSON at ${metadataPath}`,
      e,
    );
    return undefined;
  }
}

/**
 * Reads an artifact payload from disk.
 *
 * The read is attempted directly instead of being guarded by an `exists()`
 * check, so that a concurrent delete cannot be observed as a distinguishable
 * state between the check and the read.
 *
 * @param contentPath Location of the payload.
 * @returns The file contents, or undefined if it is not a readable file.
 */
async function readPayload(contentPath: string): Promise<Buffer | undefined> {
  try {
    return await fs.readFile(contentPath);
  } catch (e: unknown) {
    if (!isErrnoCode(e, 'ENOENT')) {
      logger.warn(
        `[FileArtifactService] readPayload: Unreadable artifact payload at ${contentPath}`,
        e,
      );
    }
    return undefined;
  }
}

/**
 * Gets the key an artifact is listed under.
 *
 * @param artifactDir The artifact directory.
 * @param scopeRoot The scope root the directory sits under.
 * @param prefix Namespace prefix applied to the fallback path.
 * @returns The artifact key.
 */
async function getArtifactKey(
  artifactDir: string,
  scopeRoot: string,
  prefix: string,
): Promise<string> {
  const versions = await listVersionsOnDisk(artifactDir);
  const metadata =
    versions.length > 0
      ? await readMetadata(
          getMetadataPath(artifactDir, versions[versions.length - 1]),
        )
      : undefined;
  if (metadata?.fileName) {
    return metadata.fileName;
  }
  return `${prefix}${asPosixPath(path.relative(scopeRoot, artifactDir))}`;
}

/** Lists directory entries, treating an unreadable directory as empty. */
async function readDirEntries(dir: string): Promise<Dirent[]> {
  try {
    return await fs.readdir(dir, {withFileTypes: true});
  } catch (e: unknown) {
    if (!isErrnoCode(e, 'ENOENT')) {
      logger.debug(
        `[FileArtifactService] readDirEntries: Cannot read ${dir}`,
        e,
      );
    }
    return [];
  }
}

/**
 * Iterates over artifact directories beneath a scope root.
 *
 * An artifact directory doubles as the parent of anything nested under it
 * ("doc" and "doc/nested"), so the walk continues past one, skipping only the
 * stored versions of that artifact.
 *
 * @param dir The directory to iterate over.
 * @returns An async generator that yields artifact directories.
 */
async function* iterateArtifactDirs(dir: string): AsyncGenerator<string> {
  const entries = await readDirEntries(dir);
  const hasVersions = entries.some(
    (entry) => entry.isDirectory() && entry.name === VERSIONS_DIRNAME,
  );
  if (hasVersions) {
    yield dir;
  }
  for (const entry of entries) {
    if (entry.isDirectory() && entry.name !== VERSIONS_DIRNAME) {
      yield* iterateArtifactDirs(path.join(dir, entry.name));
    }
  }
}

/**
 * Converts a path to a POSIX path.
 *
 * Used for ensuring paths use forward slashes (/), regardless of the operating system.
 *
 * @param p The path.
 * @returns The POSIX path.
 */
function asPosixPath(p: string): string {
  return p.split(path.sep).join('/');
}
