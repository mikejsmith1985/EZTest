/**
 * Unit tests for the portable release helpers.
 * These checks protect version comparison and release-asset selection logic
 * used by the Windows portable updater.
 */
import { expect, test } from '@playwright/test';
import {
  isVersionNewer,
  PORTABLE_RELEASE_ASSET_NAME,
  selectPortableReleaseAsset,
  type GithubReleaseSummary,
} from '../../src/shared/portableRelease.js';

/** Creates a minimal release object for asset-selection tests. */
function createReleaseSummary(
  assetNames: string[],
  tagName: string = 'v0.1.2',
): GithubReleaseSummary {
  return {
    tagName,
    htmlUrl: 'https://github.com/mikejsmith1985/EZTest/releases/tag/' + tagName,
    assets: assetNames.map((assetName) => ({
      name: assetName,
      browserDownloadUrl: 'https://example.test/download/' + assetName,
    })),
  };
}

test.describe('isVersionNewer', () => {
  test('returns true when the candidate patch version is newer', () => {
    expect(isVersionNewer('0.1.1', '0.1.2')).toBe(true);
  });

  test('returns true when the candidate version has a leading v prefix', () => {
    expect(isVersionNewer('0.1.1', 'v0.1.2')).toBe(true);
  });

  test('returns false when the versions are equal', () => {
    expect(isVersionNewer('0.1.2', '0.1.2')).toBe(false);
  });

  test('returns false when the candidate version is older', () => {
    expect(isVersionNewer('0.2.0', '0.1.9')).toBe(false);
  });
});

test.describe('selectPortableReleaseAsset', () => {
  test('returns the portable asset when it is present', () => {
    const releaseSummary = createReleaseSummary([
      'checksums.txt',
      PORTABLE_RELEASE_ASSET_NAME,
    ]);

    const selectedAsset = selectPortableReleaseAsset(releaseSummary);

    expect(selectedAsset?.name).toBe(PORTABLE_RELEASE_ASSET_NAME);
    expect(selectedAsset?.browserDownloadUrl).toContain(PORTABLE_RELEASE_ASSET_NAME);
  });

  test('returns null when the portable asset is missing', () => {
    const releaseSummary = createReleaseSummary(['checksums.txt', 'EZTest-macos.zip']);

    expect(selectPortableReleaseAsset(releaseSummary)).toBeNull();
  });
});
