/**
 * Core domain types for EZTest.
 * These types flow through every module — from code analysis through AI generation to test output.
 */

// ── AI Provider Types ──────────────────────────────────────────────────────

/** The supported AI model providers. Add new providers here as they become viable. */
export type AiProviderName = 'openai' | 'anthropic' | 'github' | 'copilot';

/** A single message in an AI conversation context. */
export interface AiMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

/** The response from an AI provider call. */
export interface AiResponse {
  content: string;
  /** Token usage for cost tracking */
  tokensUsed: number;
  /** The model that actually produced this response */
  modelUsed: string;
}

// ── Code Analysis Types ────────────────────────────────────────────────────

/** The kind of interactive element found in source code. */
export type InteractiveElementKind =
  | 'button'
  | 'input'
  | 'link'
  | 'form'
  | 'select'
  | 'textarea'
  | 'checkbox'
  | 'radio'
  | 'modal-trigger'
  | 'navigation'
  | 'other';

/**
 * Represents a single interactive element discovered in source code.
 * The AI uses these fields to infer what the element does from a user's perspective.
 */
export interface InteractiveElement {
  elementKind: InteractiveElementKind;
  /** Visible text content (e.g., "Submit Order", "Delete Account") */
  textContent?: string;
  /** Accessibility label — the most reliable semantic signal */
  ariaLabel?: string;
  /** The name of the event handler (e.g., "handleCheckout", "onDeleteConfirm") */
  handlerName?: string;
  /** Any data-testid or data-cy attribute for selector generation */
  testId?: string;
  /** CSS class names that may hint at purpose (e.g., "btn-danger", "submit-btn") */
  classNames?: string[];
  /** The HTML element tag */
  tagName?: string;
  /** Source file line number for traceability */
  sourceLine?: number;
}

/**
 * Represents a single analyzed component or page from the source code.
 * This is the primary input to the AI Test Synthesizer.
 */
export interface ComponentAnalysis {
  /** Absolute path to the source file */
  filePath: string;
  /** The component or page name (inferred from filename or export name) */
  componentName: string;
  /** All interactive elements found in this component's render output */
  interactiveElements: InteractiveElement[];
  /** The URL path this component is mounted at (if route-mapped) */
  routePath?: string;
  /** Other component names this component imports (for dependency mapping) */
  importedComponents: string[];
  /** The detected source framework */
  detectedFramework: 'react' | 'vue' | 'angular' | 'svelte' | 'html' | 'unknown';
  /** Raw source code of the component for AI context */
  sourceCode: string;
}

// ── Forge App Detection Types ──────────────────────────────────────────────

/**
 * Context about a Jira Forge Custom UI app detected in the project.
 *
 * Forge apps render their UI inside an iframe embedded in a Jira Cloud page.
 * Tests for these apps cannot navigate to internal React Router paths directly —
 * they must navigate to the Jira project page and then interact through frameLocator.
 *
 * This context is detected automatically from package.json (@forge/react dependency)
 * and the full Jira page URL is extracted from existing test fixtures when present.
 */
export interface ForgeAppContext {
  /** Full Jira path to the page where this Forge app is embedded, e.g. /jira/software/projects/ACRP/apps/... */
  forgeProjectPageUrl: string;
  /** Playwright frameLocator selector to locate the Forge Custom UI iframe */
  iframeSelector: string;
}

// ── User Flow Types ────────────────────────────────────────────────────────

/**
 * A single step in a user flow.
 * Describes one action a user takes and what they expect to see afterward.
 */
export interface UserFlowStep {
  /** Human-readable description of the action (e.g., "Click the Submit button") */
  actionDescription: string;
  /** The interactive element that drives this action */
  targetElement?: InteractiveElement;
  /** What the user expects to see after taking this action */
  expectedOutcome: string;
  /** Whether this step is a navigation (changes the page URL) */
  isNavigation: boolean;
}

/**
 * A complete user journey through the application.
 * EZTest generates one Playwright test file per flow.
 */
export interface UserFlow {
  /** Descriptive name for the flow (e.g., "User completes checkout", "Admin deletes an account") */
  flowName: string;
  /** The URL where this flow begins */
  startingUrl: string;
  /** Ordered steps in this flow */
  steps: UserFlowStep[];
  /** The components involved in this flow */
  involvedComponents: string[];
  /** Whether this is a happy path, error case, or edge case */
  flowKind: 'happy-path' | 'error-case' | 'edge-case';
}

// ── Test Generation Types ──────────────────────────────────────────────────

/**
 * A generated Playwright test file ready to be written to disk.
 */
export interface GeneratedTestFile {
  /** Suggested output path (e.g., tests/e2e/checkout-flow.spec.ts) */
  suggestedOutputPath: string;
  /** The complete TypeScript source of the test file */
  testSourceCode: string;
  /** The user flow this test validates */
  sourceFlow: UserFlow;
  /** Summary of what assertions are made, for human review */
  assertionSummary: string[];
}

/**
 * Options for the eztest generate command.
 */
export interface TestGenerationOptions {
  /** Root directory of the source code to analyze */
  sourceDirectory: string;
  /** URL where the target application is running */
  targetAppUrl: string;
  /** Directory where generated test files should be written */
  outputDirectory: string;
  /** Whether to include edge case and error tests (default: true) */
  shouldIncludeEdgeCases: boolean;
  /** File glob patterns to exclude from analysis */
  excludePatterns: string[];
  /** Maximum number of components to analyze (prevents runaway AI costs) */
  maxComponentCount: number;
}

// ── Session Recording Types ────────────────────────────────────────────────

/** A single recorded user interaction during a session. */
export interface RecordedInteraction {
  /** Milliseconds since session start */
  timestampMs: number;
  interactionKind: 'click' | 'input' | 'navigation' | 'scroll' | 'hover' | 'keypress';
  /** CSS selector or role-based selector for the target element */
  targetSelector: string;
  /** Human-readable description of what was interacted with */
  targetDescription?: string;
  /** The value entered (for input interactions) */
  inputValue?: string;
  /** The URL at the time of interaction */
  pageUrl: string;
  /** Serialized DOM state before the interaction */
  domStateBefore: string;
  /** Serialized DOM state after the interaction settled */
  domStateAfter: string;
  /** Any network requests triggered by this interaction */
  triggeredNetworkRequests: NetworkRequestRecord[];
}

/** A captured network request. */
export interface NetworkRequestRecord {
  url: string;
  method: string;
  statusCode?: number;
  requestBody?: string;
  responseBody?: string;
  durationMs?: number;
}

/**
 * A structured bug report created when the user flags an unexpected result.
 * This is the primary input to the Agent Feedback Loop.
 */
export interface BugReport {
  /** Unique identifier for this bug report */
  reportId: string;
  /** When the user flagged the issue */
  reportedAt: string;
  /** URL where the unexpected behavior was observed */
  observedAtUrl: string;
  /** What the user typed as their expectation description */
  userExpectation: string;
  /** All interactions leading up to the flagged moment */
  interactionHistory: RecordedInteraction[];
  /** Screenshot at the moment of flagging (base64 encoded PNG) */
  screenshotAtFlag?: string;
  /** The DOM state at the moment of flagging */
  domStateAtFlag: string;
  /** Source code context (provided separately for AI analysis) */
  sourceDirectory?: string;
}

// ── Agent Feedback Loop Types ──────────────────────────────────────────────

/** The result of the agent attempting to reproduce a bug as a failing test. */
export interface ReproductionAttempt {
  bugReportId: string;
  /** The generated Playwright test code */
  reproductionTestCode: string;
  /** Whether running the test confirmed the bug (i.e., the test failed as expected) */
  wasReproductionSuccessful: boolean;
  /** Output from running the test */
  testRunOutput: string;
}

/** The result of the agent applying a code fix. */
export interface CodeFixResult {
  bugReportId: string;
  /** Description of what was changed and why */
  fixDescription: string;
  /** Map of file path to new file content */
  changedFiles: Map<string, string>;
  /** Whether the reproduction test now passes after the fix */
  doesReproductionTestPass: boolean;
  /** Whether the full validation suite passes after the fix */
  doesValidationSuitePass: boolean;
}
