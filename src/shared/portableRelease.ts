/**
 * Portable release helpers — shared constants and pure functions used by the
 * Windows bundle builder and the in-app release updater.
 */

/** The GitHub release asset name for the Windows portable bundle zip file. */
export const PORTABLE_RELEASE_ASSET_NAME = 'EZTest-windows-portable.zip';

/** Minimal metadata we need from a GitHub release asset. */
export interface GithubReleaseAssetSummary {
  name: string;
  browserDownloadUrl: string;
}

/** Minimal metadata we need from the latest GitHub release response. */
export interface GithubReleaseSummary {
  tagName: string;
  htmlUrl: string;
  assets: GithubReleaseAssetSummary[];
}

/**
 * Compares two semver-style version strings (for example "0.1.1" and "0.1.2").
 * Returns true only when the candidate version is newer than the current version.
 */
export function isVersionNewer(currentVersion: string, candidateVersion: string): boolean {
  const normaliseVersion = (versionString: string) =>
    versionString.replace(/^v/, '').split('.').map(Number);

  const currentParts = normaliseVersion(currentVersion);
  const candidateParts = normaliseVersion(candidateVersion);

  for (let partIndex = 0; partIndex < 3; partIndex += 1) {
    const currentPartValue = currentParts[partIndex] ?? 0;
    const candidatePartValue = candidateParts[partIndex] ?? 0;

    if (candidatePartValue > currentPartValue) {
      return true;
    }

    if (candidatePartValue < currentPartValue) {
      return false;
    }
  }

  return false;
}

/**
 * Finds the portable Windows bundle asset inside a GitHub release.
 * Returns null when that asset is missing so callers can fail clearly.
 */
export function selectPortableReleaseAsset(
  releaseSummary: GithubReleaseSummary,
): GithubReleaseAssetSummary | null {
  return releaseSummary.assets.find(
    (releaseAsset) => releaseAsset.name === PORTABLE_RELEASE_ASSET_NAME,
  ) ?? null;
}
