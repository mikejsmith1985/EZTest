/**
 * Spec Generator — scans the user's source directory and generates a high-quality
 * eztest-spec.md behavioral specification by sending source excerpts to AI.
 *
 * This spec file anchors every generated test to a real user expectation rather
 * than an implementation detail — making it the single biggest quality lever in EZTest.
 */
import { readdirSync, statSync, readFileSync, existsSync } from 'node:fs';
import { join, resolve, basename, extname } from 'node:path';
import { buildSpecGenerationPrompt } from './promptTemplates.js';
import { AiClient } from '../shared/aiClient.js';
import { logInfo, logDebug, logWarning } from '../shared/logger.js';

// ── Constants ──────────────────────────────────────────────────────────────

/** File extensions recognized as application source code worth analyzing. */
const SOURCE_FILE_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx', '.vue', '.svelte']);

/**
 * Directory names to skip during source file discovery.
 * These contain generated, dependency, or build artifacts — not user-authored code.
 */
const EXCLUDED_DIRECTORY_NAMES = new Set([
  'node_modules', '.git', 'dist', 'build', '.next', 'coverage',
]);

/**
 * Maximum file size in bytes before a file is skipped.
 * Files larger than 500KB are almost certainly generated or bundled output.
 */
const MAX_SOURCE_FILE_SIZE_BYTES = 500 * 1024;

/** Default maximum number of source files to analyze per run. Keeps prompt size and API costs bounded. */
const DEFAULT_MAX_SOURCE_FILES = 15;

/** Default maximum characters to read from each source file as an excerpt. */
const DEFAULT_MAX_CHARS_PER_FILE = 4000;

/** Maximum characters to read from README.md for project context. */
const MAX_README_CHARS = 3000;

// ── Public Interfaces ──────────────────────────────────────────────────────

/**
 * Configuration for a spec generation run.
 */
export interface SpecGeneratorOptions {
  /** Directory to scan for source files (.ts, .tsx, .js, .jsx, .vue, .svelte). */
  sourceDirectory: string;
  /** Where package.json and README.md live (typically the project root). */
  projectRootDirectory: string;
  /** Already-initialized AI client to use for spec generation. */
  aiClient: AiClient;
  /** Maximum number of source files to include in the AI prompt. Defaults to 15. */
  maxSourceFiles?: number;
  /** Maximum characters to read from each source file as an excerpt. Defaults to 4000. */
  maxCharsPerFile?: number;
}

/**
 * The result of a spec generation run.
 */
export interface GeneratedSpec {
  /** The full markdown content of the generated eztest-spec.md. */
  specContent: string;
  /** Number of source files that were included in the AI analysis. */
  sourceFilesAnalyzed: number;
  /** The project name read from package.json (or inferred from directory name). */
  projectName: string;
}

// ── Internal Helpers ───────────────────────────────────────────────────────

/**
 * Recursively collects source file paths from a directory, skipping excluded
 * directories and files above the size threshold. Stops once maxFileCount is reached.
 */
function collectSourceFilePaths(
  directoryPath: string,
  maxFileCount: number,
  collectedPaths: string[] = [],
): string[] {
  if (collectedPaths.length >= maxFileCount) return collectedPaths;

  let directoryEntries: string[];
  try {
    directoryEntries = readdirSync(directoryPath);
  } catch {
    logWarning(`Could not read directory: ${directoryPath}`);
    return collectedPaths;
  }

  for (const entryName of directoryEntries) {
    if (collectedPaths.length >= maxFileCount) break;

    const fullEntryPath = join(directoryPath, entryName);

    let entryStat;
    try {
      entryStat = statSync(fullEntryPath);
    } catch {
      continue;
    }

    if (entryStat.isDirectory()) {
      // Recurse into subdirectories, but skip known non-source directories
      if (!EXCLUDED_DIRECTORY_NAMES.has(entryName)) {
        collectSourceFilePaths(fullEntryPath, maxFileCount, collectedPaths);
      }
      continue;
    }

    const fileExtension = extname(entryName).toLowerCase();
    if (!SOURCE_FILE_EXTENSIONS.has(fileExtension)) continue;

    if (entryStat.size > MAX_SOURCE_FILE_SIZE_BYTES) {
      logDebug(`Skipping oversized file (${entryStat.size} bytes): ${fullEntryPath}`);
      continue;
    }

    collectedPaths.push(fullEntryPath);
  }

  return collectedPaths;
}

/**
 * Reads a source file and returns an excerpt up to maxChars characters.
 * Returns an empty string if the file cannot be read.
 */
function readSourceFileExcerpt(filePath: string, maxChars: number): string {
  try {
    const rawContent = readFileSync(filePath, 'utf-8');
    return rawContent.slice(0, maxChars);
  } catch (readError) {
    logWarning(`Could not read source file ${filePath}: ${String(readError)}`);
    return '';
  }
}

/**
 * Reads and parses package.json from the project root directory.
 * Returns the project name and description with safe fallbacks if anything is missing.
 */
function readPackageJsonMetadata(
  projectRootDirectory: string,
): { projectName: string; packageDescription: string } {
  const packageJsonPath = join(projectRootDirectory, 'package.json');
  const fallbackProjectName = basename(resolve(projectRootDirectory));

  if (!existsSync(packageJsonPath)) {
    logDebug(`No package.json found at ${packageJsonPath}; using directory name as project name`);
    return { projectName: fallbackProjectName, packageDescription: '' };
  }

  try {
    const rawContent = readFileSync(packageJsonPath, 'utf-8');
    const parsedPackage = JSON.parse(rawContent) as { name?: string; description?: string };
    return {
      projectName: parsedPackage.name ?? fallbackProjectName,
      packageDescription: parsedPackage.description ?? '',
    };
  } catch (parseError) {
    logWarning(`Could not parse package.json: ${String(parseError)}`);
    return { projectName: fallbackProjectName, packageDescription: '' };
  }
}

/**
 * Reads README.md from the project root directory, up to MAX_README_CHARS characters.
 * Returns null if no README file is found.
 */
function readReadmeContent(projectRootDirectory: string): string | null {
  const readmeFileCandidates = ['README.md', 'readme.md', 'Readme.md'];

  for (const candidateFileName of readmeFileCandidates) {
    const readmePath = join(projectRootDirectory, candidateFileName);
    if (!existsSync(readmePath)) continue;

    try {
      const rawContent = readFileSync(readmePath, 'utf-8');
      const readmeExcerpt = rawContent.slice(0, MAX_README_CHARS);
      logDebug(`Read README from ${readmePath} (${readmeExcerpt.length} chars)`);
      return readmeExcerpt;
    } catch {
      continue;
    }
  }

  return null;
}

// ── Public API ─────────────────────────────────────────────────────────────

/**
 * Scans the user's source directory for component and page files, reads project
 * metadata from package.json and README.md, then sends everything to AI to generate
 * a high-quality behavioral specification in eztest-spec.md format.
 *
 * The generated spec answers "How does a real user know when this app is working
 * correctly?" — not "how does the code work internally?" This perspective is what
 * makes the spec so valuable as input to the test generator.
 */
export async function generateAppSpec(options: SpecGeneratorOptions): Promise<GeneratedSpec> {
  const maxSourceFiles = options.maxSourceFiles ?? DEFAULT_MAX_SOURCE_FILES;
  const maxCharsPerFile = options.maxCharsPerFile ?? DEFAULT_MAX_CHARS_PER_FILE;

  const resolvedSourceDirectory = resolve(options.sourceDirectory);
  const resolvedProjectRoot = resolve(options.projectRootDirectory);

  logInfo(`Scanning ${resolvedSourceDirectory} for source files...`);

  // ── Step 1: Collect source file excerpts ──
  const sourceFilePaths = collectSourceFilePaths(resolvedSourceDirectory, maxSourceFiles);
  logInfo(`Found ${sourceFilePaths.length} source file(s) to analyze (max: ${maxSourceFiles})`);

  const sourceCodeSummaries = sourceFilePaths
    .map(filePath => ({
      filePath,
      excerpt: readSourceFileExcerpt(filePath, maxCharsPerFile),
    }))
    .filter(summary => summary.excerpt.length > 0);

  // ── Step 2: Read project metadata ──
  const { projectName, packageDescription } = readPackageJsonMetadata(resolvedProjectRoot);
  logDebug(`Project: "${projectName}" — ${packageDescription || 'no description'}`);

  const readmeContent = readReadmeContent(resolvedProjectRoot);
  if (readmeContent) {
    logDebug(`README.md loaded for context (${readmeContent.length} chars)`);
  }

  // ── Step 3: Build prompt and call AI ──
  logInfo(`Sending ${sourceCodeSummaries.length} source excerpt(s) to AI for spec generation...`);

  const promptMessages = buildSpecGenerationPrompt(
    projectName,
    packageDescription,
    sourceCodeSummaries,
    readmeContent,
  );

  const aiResponse = await options.aiClient.chat(
    promptMessages,
    `generate eztest-spec.md for ${projectName}`,
  );

  return {
    specContent: aiResponse.content.trim(),
    sourceFilesAnalyzed: sourceCodeSummaries.length,
    projectName,
  };
}
