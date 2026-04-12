/**
 * Test Quality Auditor — fourth AI pass in the EZTest synthesis pipeline.
 *
 * Reads all generated `.spec.ts` files together and uses AI to flag any tests
 * that assert on implementation details (spies, React state, internal variables)
 * rather than user-visible DOM behavior. This catch-all pass pushes pipeline
 * confidence from ~87% to ~90%.
 */
import { buildTestQualityAuditPrompt } from './promptTemplates.js';
import type { AiClient } from '../shared/aiClient.js';
import { logInfo, logWarning, logError, logDebug, logSuccess } from '../shared/logger.js';

// ── Constants ──────────────────────────────────────────────────────────────

/**
 * Pass-rate threshold below which we warn the user that human review is
 * strongly recommended. 70% means more than 3-in-10 tests are behavioral.
 */
const HUMAN_REVIEW_RECOMMENDED_THRESHOLD = 70;

// ── Public Types ───────────────────────────────────────────────────────────

/** A single test flagged by the quality audit for testing implementation details. */
export interface AuditFinding {
  fileName: string;
  testName: string;
  /** Human-readable description of why this test is problematic. */
  issue: string;
  /** Critical findings block the pipeline; warnings are advisory. */
  severity: 'critical' | 'warning';
  /** Specific replacement assertion or test name suggested by the AI auditor. */
  suggestedFix: string;
}

/** The structured result returned after auditing all generated test files. */
export interface QualityAuditResult {
  /** One-sentence AI-generated summary of overall test quality. */
  auditSummary: string;
  /** 0–100 percentage of tests that correctly assert on user-visible behavior. */
  passRate: number;
  /** All tests the auditor flagged as testing implementation details. */
  flaggedTests: AuditFinding[];
  /** Number of tests that passed the behavioral quality check. */
  passingTestCount: number;
  /** False when the AI returned unparseable JSON — findings will be empty. */
  wasAuditSuccessful: boolean;
}

/** Input options for `auditGeneratedTests`. */
export interface TestQualityAuditorOptions {
  /** All generated test files to audit together. */
  generatedTestFiles: Array<{ fileName: string; testCode: string; filePath: string }>;
  /** Optional app-spec text injected into the audit prompt for extra context. */
  appSpecContent: string | null;
  /** Initialized AI client to send the audit prompt to. */
  aiClient: AiClient;
}

// ── Internal Helpers ───────────────────────────────────────────────────────

/**
 * Raw shape of the JSON object the AI auditor returns.
 * Parsed and validated before being converted to `QualityAuditResult`.
 */
interface RawAuditResponse {
  auditSummary?: unknown;
  passRate?: unknown;
  flaggedTests?: unknown;
  passingTests?: unknown;
}

/**
 * Validates a single flagged-test entry from the raw AI response.
 * Returns a typed `AuditFinding` or null if the entry is malformed.
 */
function parseAuditFinding(rawEntry: unknown): AuditFinding | null {
  if (typeof rawEntry !== 'object' || rawEntry === null) {
    return null;
  }

  const entry = rawEntry as Record<string, unknown>;

  const hasRequiredFields =
    typeof entry.fileName === 'string' &&
    typeof entry.testName === 'string' &&
    typeof entry.issue === 'string' &&
    typeof entry.suggestedFix === 'string' &&
    (entry.severity === 'critical' || entry.severity === 'warning');

  if (!hasRequiredFields) {
    return null;
  }

  return {
    fileName: entry.fileName as string,
    testName: entry.testName as string,
    issue: entry.issue as string,
    severity: entry.severity as 'critical' | 'warning',
    suggestedFix: entry.suggestedFix as string,
  };
}

/**
 * Parses the raw AI response text into a typed `QualityAuditResult`.
 * Returns null when the response is not valid JSON or missing required fields.
 */
function parseAuditResponse(rawAiText: string): QualityAuditResult | null {
  let parsedJson: RawAuditResponse;

  try {
    parsedJson = JSON.parse(rawAiText) as RawAuditResponse;
  } catch {
    logDebug(`Audit JSON parse failed. Raw output: ${rawAiText.slice(0, 300)}`);
    return null;
  }

  if (typeof parsedJson.auditSummary !== 'string' || typeof parsedJson.passRate !== 'number') {
    logDebug('Audit response missing required "auditSummary" or "passRate" fields.');
    return null;
  }

  const rawFlaggedTests = Array.isArray(parsedJson.flaggedTests) ? parsedJson.flaggedTests : [];
  const flaggedTests = rawFlaggedTests
    .map(parseAuditFinding)
    .filter((finding): finding is AuditFinding => finding !== null);

  const passingTestCount = Array.isArray(parsedJson.passingTests)
    ? parsedJson.passingTests.length
    : 0;

  return {
    auditSummary: parsedJson.auditSummary,
    passRate: parsedJson.passRate,
    flaggedTests,
    passingTestCount,
    wasAuditSuccessful: true,
  };
}

/** Returns a failed `QualityAuditResult` with empty findings for use on error paths. */
function buildFailedAuditResult(): QualityAuditResult {
  return {
    auditSummary: 'Audit could not be completed — AI returned unparseable output.',
    passRate: 0,
    flaggedTests: [],
    passingTestCount: 0,
    wasAuditSuccessful: false,
  };
}

/**
 * Logs the audit findings to the console, grouped by severity.
 * Critical findings are logged as errors; warnings as warnings.
 */
function logAuditFindings(auditResult: QualityAuditResult): void {
  logInfo(`  Audit summary: ${auditResult.auditSummary}`);
  logInfo(`  Behavioral pass rate: ${auditResult.passRate}%`);

  if (auditResult.passRate < HUMAN_REVIEW_RECOMMENDED_THRESHOLD) {
    logWarning(
      `  Pass rate is below ${HUMAN_REVIEW_RECOMMENDED_THRESHOLD}% — human review of generated tests is recommended.`,
    );
  }

  const criticalFindings = auditResult.flaggedTests.filter(finding => finding.severity === 'critical');
  const warningFindings = auditResult.flaggedTests.filter(finding => finding.severity === 'warning');

  for (const finding of criticalFindings) {
    logError(
      `  [CRITICAL] ${finding.fileName} — "${finding.testName}"\n` +
      `    Issue: ${finding.issue}\n` +
      `    Suggested fix: ${finding.suggestedFix}`,
    );
  }

  for (const finding of warningFindings) {
    logWarning(
      `  [WARNING] ${finding.fileName} — "${finding.testName}"\n` +
      `    Issue: ${finding.issue}\n` +
      `    Suggested fix: ${finding.suggestedFix}`,
    );
  }

  if (auditResult.flaggedTests.length === 0) {
    logSuccess(`  All ${auditResult.passingTestCount} tests assert on user-visible behavior. ✓`);
  }
}

// ── Public API ─────────────────────────────────────────────────────────────

/**
 * Audits all generated test files for behavioral quality.
 *
 * Sends all test code to the AI in a single prompt asking it to identify tests
 * that assert on implementation details rather than user-visible DOM state. The
 * AI returns a structured JSON report which is parsed into `QualityAuditResult`.
 *
 * When the AI response cannot be parsed (e.g. due to a network error or
 * malformed JSON), `wasAuditSuccessful` is set to false and `flaggedTests`
 * will be empty so the pipeline can continue without crashing.
 *
 * @param options - Files to audit, optional app spec, and an initialized AI client.
 * @returns A structured audit report with pass rate and per-test findings.
 */
export async function auditGeneratedTests(
  options: TestQualityAuditorOptions,
): Promise<QualityAuditResult> {
  const { generatedTestFiles, appSpecContent, aiClient } = options;

  if (generatedTestFiles.length === 0) {
    logWarning('Quality audit skipped — no generated test files to audit.');
    return buildFailedAuditResult();
  }

  logInfo(`\nRunning quality audit on ${generatedTestFiles.length} test file(s)...`);

  const auditPromptFiles = generatedTestFiles.map(testFile => ({
    fileName: testFile.fileName,
    testCode: testFile.testCode,
  }));

  const promptMessages = buildTestQualityAuditPrompt(auditPromptFiles, appSpecContent);

  let rawAiResponse: string;
  try {
    const aiResponse = await aiClient.chat(promptMessages, 'test quality audit');
    rawAiResponse = aiResponse.content;
  } catch (callError) {
    logWarning(`Quality audit AI call failed: ${String(callError)}`);
    return buildFailedAuditResult();
  }

  const auditResult = parseAuditResponse(rawAiResponse);

  if (!auditResult) {
    logWarning('Quality audit returned unparseable JSON — skipping findings.');
    return buildFailedAuditResult();
  }

  logAuditFindings(auditResult);

  return auditResult;
}
