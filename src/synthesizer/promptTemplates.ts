/**
 * AI Prompt Templates for EZTest.
 *
 * These prompts are the most important part of EZTest — they are carefully designed
 * to instruct the AI to think like a QA engineer testing from a USER perspective,
 * NOT like a developer testing code structure. Every word in these prompts matters.
 *
 * Key principles enforced in all prompts:
 * 1. Assert on DOM state and user-visible outcomes, NEVER on function calls or internal state
 * 2. Use accessible selectors (role, label, text) over brittle CSS class selectors
 * 3. Think about what a real user would see and do, not what the code does internally
 * 4. Every happy-path flow MUST have a corresponding error-case and edge-case flow
 * 5. The "So What" rule: if an assertion doesn't verify something a user sees, remove it
 */
import type { ComponentAnalysis, ForgeAppContext, UserFlow } from '../shared/types.js';
import type { AiMessage } from '../shared/types.js';

// ── System Prompts ─────────────────────────────────────────────────────────

/**
 * The base system prompt injected into every AI conversation in EZTest.
 * Establishes the AI's identity as a purely behavioral QA engineer who
 * cannot see the source code — only the running browser.
 *
 * This prompt is deliberately strict. The single biggest failure mode in
 * AI-generated tests is asserting on implementation details (function calls,
 * state variables, component props) instead of user-visible outcomes.
 * Every rule here exists to prevent that failure mode.
 */
const BEHAVIORAL_QA_SYSTEM_PROMPT = `You are a senior QA engineer writing Playwright end-to-end tests.

Your SOLE job is to verify that users can accomplish their goals — not to verify that code is written correctly.

THE QA MINDSET (internalize this before writing a single line):
- You are a real user sitting at a browser. You cannot see the source code. You see only what appears on screen.
- A test PASSES when the user's goal is achieved. A test FAILS when it is not.
- You do not care HOW the code achieves a result. You care only WHAT appears in the browser as a result.

STRICT RULES — violating any one of these makes the entire test worthless:
1. NEVER assert that a function was called (no toHaveBeenCalled, no spies, no mocks, no vi.fn())
2. NEVER assert on React state, Redux store, component props, or any internal JavaScript variable
3. NEVER import or reference the application's source code in a test file
4. ALWAYS assert on what appears in the DOM: visible text, element presence/absence, URL changes, form state, error messages
5. Use Playwright's semantic locators: getByRole(), getByLabel(), getByText(), getByPlaceholder()
6. CSS selectors (.class, #id) and data-testid are ONLY allowed as a last resort when no semantic alternative exists
7. Every user action (click, type, submit) MUST be immediately followed by at least one expect() that proves the action had the correct visible effect
8. If a user action can fail (invalid form, unauthorized, network error), write a test that proves the failure is handled gracefully — the user must see a meaningful error message
9. NEVER use page.waitForTimeout() — Playwright auto-waits; forced sleeps mask real failures and make tests fragile

THE "SO WHAT" RULE — apply this before writing any expect() call:
Ask: "What does the USER see or experience as a direct result of this action?"
If the answer is "nothing visible to the user" or "an internal variable changes", REMOVE that assertion.
Replace it with an assertion about what the user actually observes.

EXAMPLES of worthless assertions (never write these):
  expect(handleSubmit).toHaveBeenCalledWith({ email: 'test@test.com' })  // tests code
  expect(cartStore.items).toHaveLength(3)                                 // tests state
  expect(component.props.isLoading).toBe(false)                          // tests implementation

EXAMPLES of good assertions (write these instead):
  await expect(page.getByRole('alert')).toHaveText('Order placed successfully!')  // tests outcome
  await expect(page.getByRole('button', { name: 'Checkout' })).toBeEnabled()      // tests user state
  await expect(page).toHaveURL('/order-confirmation')                              // tests navigation
  await expect(page.getByText('3 items in cart')).toBeVisible()                   // tests visible state
`;

// ── Max Source Code Characters Per Component ──────────────────────────────

/**
 * How many characters of source code to include per component in SINGLE-COMPONENT prompts
 * (e.g., the component intent analysis step). These calls only analyze one component at a
 * time, so they can afford a much larger excerpt without hitting API token limits.
 */
const MAX_SOURCE_CHARS_PER_COMPONENT = 8000;

/**
 * How many characters of source code to include per component when ALL components are
 * sent together in a BATCH prompt (e.g., user flow generation).
 *
 * The GitHub Models API has an 8000-token input limit. With 20-30 components in one call,
 * each component can only budget ~200-300 tokens of source. At ~4 chars per token, 400 chars
 * gives the AI enough business context (the component's JSX structure and key handlers)
 * without blowing the request size limit.
 *
 * Quality trade-off: less source context means fewer nuanced insights, but the element list
 * (which is always fully included) carries most of the actionable signal for flow generation.
 */
const MAX_BATCH_SOURCE_CHARS_PER_COMPONENT = 400;

// ── App Spec Injection Helper ──────────────────────────────────────────────

/**
 * Compact system prompt for the flow-mapping stage.
 *
 * The full BEHAVIORAL_QA_SYSTEM_PROMPT is ~875 tokens — too large when combined with
 * 20+ components and an app spec in a single 8K-token request to GitHub Models.
 * This prompt conveys the essential instruction (produce JSON flows) in ~150 tokens,
 * leaving the budget for component data and app spec context where the quality signal is.
 */
const FLOW_GENERATION_SYSTEM_PROMPT = `You are a QA engineer mapping application components to user flows.
Your job: given a list of UI components with their interactive elements, identify the complete set of user journeys to test.
A user flow is a sequence of actions a real user takes to accomplish a goal across one or more pages.
Respond ONLY with a valid JSON array. No markdown, no explanation.`;

/**
 * Formats the optional app spec (README / eztest-spec.md) into a prompt section.
 * The app spec is the single biggest quality lever — it gives the AI the business
 * intent of the application, not just what the code does mechanically.
 *
 * @param maxChars - Maximum characters to include. Defaults to 2000 (≈500 tokens) which
 *   keeps the app spec within the 8K-token GitHub Models input limit when combined with
 *   the flow-generation system prompt and 20-30 component summaries.
 */
function formatAppSpecSection(appSpec: string | undefined, maxChars = 2000): string {
  if (!appSpec) return '';
  return `\nAPP PURPOSE (use this to understand what users are trying to do):
${appSpec.slice(0, maxChars)}

`;
}

/**
 * Formats Forge app context into a flow-generation prompt section.
 *
 * When a Jira Forge Custom UI app is detected, the AI must understand that internal
 * React Router paths like /dashboard are NOT direct URLs. Every user flow starts at
 * the Jira project page, and navigation happens via nav bar button clicks inside the
 * iframe — not via page.goto() to different paths.
 */
function resolveForgeProjectPageUrl(
  forgeAppContext: ForgeAppContext,
  targetAppUrl: string,
): string {
  const detectedForgeProjectPageUrl = forgeAppContext.forgeProjectPageUrl?.trim();
  if (!detectedForgeProjectPageUrl) {
    return '<FORGE_PROJECT_PAGE_URL>';
  }

  try {
    return new URL(detectedForgeProjectPageUrl).toString();
  } catch {
    // Continue — this is a relative Jira path and needs the configured app URL host.
  }

  try {
    return new URL(detectedForgeProjectPageUrl, targetAppUrl).toString();
  } catch {
    return detectedForgeProjectPageUrl;
  }
}

function formatForgeFlowInstructions(
  forgeAppContext: ForgeAppContext,
  targetAppUrl: string,
): string {
  const pageUrl = resolveForgeProjectPageUrl(forgeAppContext, targetAppUrl);
  return `
IMPORTANT — JIRA FORGE APP ARCHITECTURE:
This application is a Jira Forge Custom UI app rendered inside an iframe in Jira Cloud.
- Tests CANNOT navigate to internal paths like /dashboard, /dsu-board, /story-pointing — these are React Router paths inside the iframe, not real URLs.
- ALL flows must start at the single Jira page: "${pageUrl}"
- Navigation between app views is done by CLICKING nav bar buttons (e.g., a button labeled "Team Health"), NOT by changing URLs.
- The "startingRoute" in every flow must be "${pageUrl}" — the same URL for all flows.
- Describe navigation steps as "click the [Tab Name] nav button", not "navigate to /path".

`;
}

/**
 * Formats Forge app context into the test code generation prompt.
 *
 * Provides mandatory code patterns the AI MUST use for Forge apps.
 * Without these patterns, tests will fail immediately because they navigate
 * to internal React Router paths that don't exist as direct browser URLs.
 */
function formatForgeTestInstructions(
  forgeAppContext: ForgeAppContext,
  targetAppUrl: string,
): string {
  const pageUrl = resolveForgeProjectPageUrl(forgeAppContext, targetAppUrl);
  const iframeSel = forgeAppContext.iframeSelector;
  return `
MANDATORY — JIRA FORGE APP: USE THESE EXACT PATTERNS:
This app renders inside a Jira iframe. You MUST use frameLocator — page.goto('/dashboard') will FAIL.

REQUIRED CONSTANTS (put these at the top of the file, after imports):
const FORGE_PROJECT_PAGE = '${pageUrl}';
const IFRAME_LOAD_TIMEOUT_MS = 90_000;
const TAB_RENDER_TIMEOUT_MS = 30_000;

REQUIRED NAVIGATION PATTERN (use this in every test):
  await page.goto(FORGE_PROJECT_PAGE);
  await page.waitForLoadState('load', { timeout: IFRAME_LOAD_TIMEOUT_MS });
  const vantageFrame = page.frameLocator('${iframeSel}').first();
  await expect(vantageFrame.locator('nav button').first()).toBeVisible({ timeout: IFRAME_LOAD_TIMEOUT_MS });

TO NAVIGATE TO A VIEW (click nav button, do NOT use page.goto):
  await vantageFrame.locator('nav button', { hasText: 'Team Health' }).click();
  await vantageFrame.locator('main').first().waitFor({ state: 'visible', timeout: TAB_RENDER_TIMEOUT_MS });

ALL ASSERTIONS must use vantageFrame, not page:
  await expect(vantageFrame.getByText(/Sprint/i)).toBeVisible();

DO NOT use page.getByRole() or page.getByText() for app content — it is inside the iframe.

`;
}

// ── Component Intent Analysis Prompt ──────────────────────────────────────

/**
 * Builds the prompt that asks the AI to interpret a component's user-facing purpose.
 * The AI reads the component source and describes what a user can DO with it,
 * without referencing any implementation details.
 *
 * @param appSpec - Optional plain-English description of the app's purpose and features.
 *   When provided, dramatically improves the AI's understanding of what each component
 *   is designed to accomplish for the user.
 */
export function buildComponentIntentPrompt(
  analysis: ComponentAnalysis,
  appSpec?: string,
): AiMessage[] {
  const elementSummary = analysis.interactiveElements
    .map(element => {
      const parts = [`- ${element.elementKind.toUpperCase()}`];
      if (element.textContent) parts.push(`text: "${element.textContent}"`);
      if (element.ariaLabel) parts.push(`aria-label: "${element.ariaLabel}"`);
      if (element.handlerName) parts.push(`handler: ${element.handlerName}`);
      if (element.testId) parts.push(`testId: ${element.testId}`);
      return parts.join(', ');
    })
    .join('\n');

  // Truncation note tells the AI when it's seeing partial source — avoids wrong conclusions
  const sourceCode = analysis.sourceCode;
  const isTruncated = sourceCode.length > MAX_SOURCE_CHARS_PER_COMPONENT;
  const truncationNote = isTruncated
    ? `\n[Note: Source truncated at ${MAX_SOURCE_CHARS_PER_COMPONENT} chars. Full file is ${sourceCode.length} chars.]`
    : '';

  return [
    {
      role: 'system',
      content: BEHAVIORAL_QA_SYSTEM_PROMPT,
    },
    {
      role: 'user',
      content: `Analyze this component and describe what a USER can do with it.
${formatAppSpecSection(appSpec)}
COMPONENT NAME: ${analysis.componentName}
ROUTE: ${analysis.routePath ?? 'unknown'}
FRAMEWORK: ${analysis.detectedFramework}

INTERACTIVE ELEMENTS FOUND:
${elementSummary}

SOURCE CODE:${truncationNote}
\`\`\`${analysis.detectedFramework === 'react' ? 'tsx' : 'html'}
${sourceCode.slice(0, MAX_SOURCE_CHARS_PER_COMPONENT)}
\`\`\`

Respond with a JSON object with this exact structure:
{
  "componentPurpose": "One sentence describing what this component/page does for the user",
  "userActions": [
    {
      "actionName": "descriptive name of the action",
      "description": "what the user does and what they expect to happen",
      "triggerElement": "the button/link/input that triggers this",
      "expectedOutcome": "what the user sees/experiences after the action",
      "canFail": true/false,
      "failureOutcome": "what the user sees if this action fails (only if canFail is true)"
    }
  ],
  "requiredSetup": "any prerequisites (must be logged in, must have items in cart, etc.)"
}

Only return valid JSON. No markdown fences, no explanation.`,
    },
  ];
}

// ── User Flow Generation Prompt ────────────────────────────────────────────

/**
 * Builds the prompt that asks the AI to combine multiple component analyses
 * into complete end-to-end user journeys.
 *
 * This is called after analyzing all components in the app, giving the AI
 * a holistic view so it can generate flows that span multiple pages.
 *
 * Critical improvement over simple component analysis: this prompt includes
 * richer source context per component (not just element names), the app spec
 * for business intent, and a MANDATORY requirement that every happy-path flow
 * has corresponding error-case and edge-case flows.
 *
 * @param appSpec - Optional plain-English description of the app's purpose.
 *   This is the single biggest quality lever — it tells the AI what the app
 *   is SUPPOSED to do, not just what elements exist in the code.
 * @param forgeAppContext - When provided, adds Jira Forge iframe navigation instructions.
 *   Forge apps render inside an iframe — flows must use nav tab clicks, not page.goto().
 */
export function buildUserFlowGenerationPrompt(
  componentAnalyses: ComponentAnalysis[],
  targetAppUrl: string,
  appSpec?: string,
  forgeAppContext?: ForgeAppContext,
): AiMessage[] {
  // In batch flow generation, we send ALL components in one call. Source code is omitted
  // because including even a small excerpt per component pushes the request past the
  // GitHub Models 8K-token input limit (system prompt alone is ~700 tokens, plus 26
  // components × element list = another 1300+ tokens).
  //
  // The element list (kind, label, handler name) carries the essential behavioral signal
  // the AI needs to identify user flows. The app spec (README) provides the business
  // context that source excerpts were previously approximating.
  const componentSummaries = componentAnalyses
    .map(analysis => {
      const elementList = analysis.interactiveElements
        .map(element => {
          const label = element.textContent ?? element.ariaLabel ?? element.handlerName ?? element.elementKind;
          const canFail = element.handlerName?.toLowerCase().includes('submit') ||
            element.handlerName?.toLowerCase().includes('save') ||
            element.handlerName?.toLowerCase().includes('delete');
          return `  - ${element.elementKind}: "${label}"${canFail ? ' [can fail]' : ''}`;
        })
        .join('\n');

      return `### ${analysis.componentName}${analysis.routePath ? ` (route: ${analysis.routePath})` : ''}
Elements:
${elementList}`;
    })
    .join('\n\n');

  return [
    {
      role: 'system',
      // Use the compact prompt — the full BEHAVIORAL_QA_SYSTEM_PROMPT is too long for
      // batch calls that already carry 20+ components + app spec within the 8K token limit.
      content: FLOW_GENERATION_SYSTEM_PROMPT,
    },
    {
      role: 'user',
      content: `Identify all USER FLOWS for this application.
${formatAppSpecSection(appSpec)}BASE URL: ${targetAppUrl}
${forgeAppContext ? formatForgeFlowInstructions(forgeAppContext, targetAppUrl) : ''}
COMPONENTS:
${componentSummaries}

COVERAGE REQUIREMENTS:
For EVERY happy-path flow, also generate:
1. An ERROR-CASE flow: user sees a meaningful error message (bad input, unauthorized, network error)
2. An EDGE-CASE flow: empty state, boundary value, or already-completed action

Return a JSON array. Each item:
{"flowName":"verb-first name","startingRoute":"/path","flowKind":"happy-path"|"error-case"|"edge-case","steps":[{"stepDescription":"what user does","targetElementDescription":"element name","expectedOutcome":"what user sees","isNavigation":true/false}],"involvedComponents":["Name"],"testPriority":"critical"|"high"|"medium"}

Only return valid JSON array.`,
    },
  ];
}

// ── Element Context for Test Generation ────────────────────────────────────

/**
 * Maximum characters of source code per component included in the test generation prompt.
 * Test generation runs one flow at a time (not batched), so we can afford more context
 * than flow generation. This gives the AI enough JSX structure to understand the DOM.
 */
const MAX_TEST_GEN_SOURCE_CHARS_PER_COMPONENT = 3000;

/**
 * Builds a section describing the actual interactive elements available in the components
 * involved in a user flow. This gives the test-writing AI concrete selectors (aria-labels,
 * test IDs, text content, element roles) instead of forcing it to guess from text descriptions.
 *
 * Without this context, the AI falls back to trivial "page loads" assertions because it
 * cannot know what DOM elements actually exist or what selectors will locate them.
 */
function buildElementContextSection(involvedComponentAnalyses: ComponentAnalysis[]): string {
  if (involvedComponentAnalyses.length === 0) return '';

  const componentSections = involvedComponentAnalyses.map(analysis => {
    const elementDescriptions = analysis.interactiveElements.map(element => {
      const parts = [`  - ${element.elementKind.toUpperCase()}`];
      if (element.textContent) parts.push(`text: "${element.textContent}"`);
      if (element.ariaLabel) parts.push(`aria-label: "${element.ariaLabel}"`);
      if (element.testId) parts.push(`testId: "${element.testId}"`);
      if (element.handlerName) parts.push(`handler: ${element.handlerName}`);
      if (element.classNames?.length) parts.push(`classes: [${element.classNames.join(', ')}]`);
      return parts.join(', ');
    }).join('\n');

    // Include a truncated source excerpt so the AI sees the JSX structure
    const sourceExcerpt = analysis.sourceCode.length > MAX_TEST_GEN_SOURCE_CHARS_PER_COMPONENT
      ? analysis.sourceCode.slice(0, MAX_TEST_GEN_SOURCE_CHARS_PER_COMPONENT) + '\n[...truncated]'
      : analysis.sourceCode;

    return `### ${analysis.componentName}${analysis.routePath ? ` (route: ${analysis.routePath})` : ''}
Elements:
${elementDescriptions}

Source excerpt:
\`\`\`tsx
${sourceExcerpt}
\`\`\``;
  }).join('\n\n');

  return `
AVAILABLE INTERACTIVE ELEMENTS (these are the REAL elements in the DOM — use them for precise selectors):
${componentSections}

SELECTOR STRATEGY — use the element metadata above to write PRECISE locators:
- If an element has an aria-label → getByLabel("exact aria-label value")
- If an element has a testId → getByTestId("testId value")
- If an element has visible text → getByRole('button', { name: 'visible text' }) or getByText('visible text')
- NEVER guess selectors — if you cannot find a matching element above, use the most specific text match available
`;
}

// ── Test Code Generation Prompt ────────────────────────────────────────────

/**
 * Builds the prompt that generates actual Playwright test code from a user flow description.
 * This is the final stage — the AI writes TypeScript Playwright tests that assert on
 * real DOM state and user-visible outcomes.
 *
 * @param appSpec - Optional plain-English app description. When present, the AI can use
 *   it to resolve ambiguity about what the "correct" expected outcome is.
 * @param forgeAppContext - When provided, adds mandatory Forge iframe navigation patterns.
 *   Without this context, Forge app tests will navigate to wrong URLs and fail immediately.
 * @param involvedComponentAnalyses - Component analyses for the components involved in this
 *   flow. Provides the AI with real element metadata (aria-labels, testIds, text, handlers)
 *   so it can write precise selectors instead of guessing and falling back to smoke tests.
 */
export function buildTestCodeGenerationPrompt(
  userFlow: UserFlow,
  targetAppUrl: string,
  appSpec?: string,
  feedbackContext?: string,
  forgeAppContext?: ForgeAppContext,
  involvedComponentAnalyses?: ComponentAnalysis[],
): AiMessage[] {
  const stepsDescription = userFlow.steps
    .map((step, stepIndex) => {
      let description = `Step ${stepIndex + 1}: ${step.actionDescription}`;
      if (step.targetElementDescription) {
        description += `\n  → Target element: ${step.targetElementDescription}`;
      }
      description += `\n  → Expected visible outcome: ${step.expectedOutcome}`;
      description += `\n  → Navigation: ${step.isNavigation ? 'yes (URL changes)' : 'no'}`;
      return description;
    })
    .join('\n');

  const elementContext = involvedComponentAnalyses && involvedComponentAnalyses.length > 0
    ? buildElementContextSection(involvedComponentAnalyses)
    : '';

  return [
    {
      role: 'system',
      content: BEHAVIORAL_QA_SYSTEM_PROMPT,
    },
    {
      role: 'user',
      content: `Write a complete Playwright TypeScript test for this user flow.
${formatAppSpecSection(appSpec)}
FLOW: ${userFlow.flowName}
KIND: ${userFlow.flowKind}
BASE URL: ${targetAppUrl}
STARTING PATH: ${userFlow.startingUrl}
${forgeAppContext ? formatForgeTestInstructions(forgeAppContext, targetAppUrl) : ''}${elementContext}
STEPS:
${stepsDescription}

REQUIREMENTS:
1. Import from @playwright/test only — no application source imports
2. Use page.getByRole(), page.getByLabel(), page.getByText(), page.getByPlaceholder() for locators
3. EVERY step MUST have at least one expect() assertion on what the user SEES — not what code executes
4. Use await expect(locator).toBeVisible() / toHaveText() / toBeEnabled() / toHaveURL() etc.
5. Do NOT use page.waitForTimeout() — let Playwright auto-wait
6. For error-case flows: assert the error message is VISIBLE and READABLE to the user
7. For edge-case flows: assert the graceful handling is visible (empty state message, disabled button, etc.)
8. Include a descriptive test name that describes the USER OUTCOME, not the technical operation
9. Apply the SO WHAT rule to every assertion: if the user wouldn't notice it, remove it

CRITICAL — DO NOT WRITE SMOKE TESTS:
- A test that ONLY navigates to a page and checks "something is visible" is WORTHLESS
- Every test MUST interact with at least one element (click a button, fill a form, select an option)
- Every test MUST assert on a SPECIFIC outcome (exact text, specific element state, URL change) — not just "page has content"
- If the flow says "user clicks Submit", the test MUST click the Submit button AND assert on what happens AFTER
- Regex matchers like /Submit|Cancel|Loading/i that match ANY of several unrelated words are FORBIDDEN — assert on the SPECIFIC expected text
- A test that passes when the feature is completely broken is worse than no test at all

Output ONLY the complete TypeScript test file content. No explanation, no markdown fences.
The file should be ready to run with \`playwright test\`.${feedbackContext ? `\n\n${feedbackContext}` : ''}`,
    },
  ];
}

// ── Assertion Review Prompt ────────────────────────────────────────────────

/**
 * Builds the prompt for the second-pass assertion reviewer.
 *
 * After the AI generates a test file, this reviewer scans it for any assertions
 * that test implementation details (function calls, state variables, component props)
 * rather than user-visible outcomes, and replaces them with behavioral equivalents.
 *
 * This is the quality net that catches code-level assertions that slip through
 * the initial generation prompt despite the strict instructions.
 */
export function buildAssertionReviewPrompt(generatedTestCode: string): AiMessage[] {
  return [
    {
      role: 'system',
      content: BEHAVIORAL_QA_SYSTEM_PROMPT,
    },
    {
      role: 'user',
      content: `Review this generated Playwright test. Find any assertions that test IMPLEMENTATION DETAILS instead of USER-VISIBLE BEHAVIOR and replace them with behavioral assertions.

GENERATED TEST:
\`\`\`typescript
${generatedTestCode}
\`\`\`

WHAT TO LOOK FOR AND FIX:
1. Any expect() call that checks if a function was called → replace with what the user SEES after the call
2. Any expect() call on React/Vue/Angular state or component props → replace with DOM assertion
3. Any expect() on CSS classes that are internal implementation (not visible styling) → replace with visible state
4. Any action step with NO following expect() → add the correct behavioral assertion
5. Any page.waitForTimeout() → remove it (Playwright auto-waits; if timing is needed, use page.waitForSelector or expect with polling)
6. Any import of the application's source code → remove it entirely

FOR EACH PROBLEM FOUND, explain in a one-line comment what you changed and why, then apply the fix.

If the test is already fully behavioral (every assertion checks what a user sees, hears, or reads), return it EXACTLY unchanged.

Output ONLY the corrected TypeScript test file. No explanation outside the inline comments.`,
    },
  ];
}

// ── Test Regeneration Prompt ───────────────────────────────────────────────

/**
 * Builds the prompt for regenerating a test that failed during the run-and-fix pass.
 *
 * When EZTest runs generated tests immediately after creation and a test fails,
 * this prompt asks the AI to diagnose whether the failure is:
 * a) A locator/selector problem (the AI guessed wrong element names) — fix the test
 * b) A genuine missing feature/bug in the app — keep the test failing, add a comment
 *
 * Regeneration preserves the BEHAVIORAL intent of the original test while fixing
 * the mechanical issue of selectors that don't match the actual DOM.
 *
 * @param userFlow - The original user flow the test was generated for
 * @param failingTestCode - The test code that failed
 * @param playwrightErrorOutput - Raw output from the Playwright test run
 * @param targetAppUrl - The URL the tests run against
 * @param appSpec - Optional app spec for additional context
 */
export function buildTestRegenerationPrompt(
  userFlow: UserFlow,
  failingTestCode: string,
  playwrightErrorOutput: string,
  targetAppUrl: string,
  appSpec?: string,
): AiMessage[] {
  // Truncate the error output to keep token usage bounded
  const truncatedErrorOutput = playwrightErrorOutput.slice(0, 3000);

  return [
    {
      role: 'system',
      content: BEHAVIORAL_QA_SYSTEM_PROMPT,
    },
    {
      role: 'user',
      content: `A Playwright test you generated has FAILED. Diagnose why and fix it.
${formatAppSpecSection(appSpec)}
ORIGINAL FLOW: ${userFlow.flowName} (${userFlow.flowKind})
TARGET URL: ${targetAppUrl}

WHAT THE FLOW IS TESTING:
${userFlow.steps.map((step, index) => `${index + 1}. ${step.actionDescription}\n   Expected: ${step.expectedOutcome}`).join('\n')}

FAILING TEST CODE:
\`\`\`typescript
${failingTestCode}
\`\`\`

PLAYWRIGHT ERROR OUTPUT:
\`\`\`
${truncatedErrorOutput}
\`\`\`

DIAGNOSIS RULES:
1. If the error is "locator not found" or "element not visible" → the selector guessed wrong. Fix by:
   - Use more flexible text matchers: getByText('partial text', { exact: false })
   - Try getByRole with a broader role type
   - Try getByTestId if a data-testid attribute might exist
   - Add await page.waitForLoadState('networkidle') before the first interaction if navigation is involved
2. If the error is "page.goto timed out" → the app may not be running; add a comment but keep the test
3. If the error is a genuine assertion failure (element exists but shows wrong text) → this is a REAL BUG. Do NOT change the assertion. Add a comment: // TODO: This test reveals a bug — [describe what should happen]
4. NEVER weaken an assertion to make it pass (e.g., don't change .toHaveText('Exact text') to .toBeVisible() just to avoid failure)
5. NEVER add page.waitForTimeout() — fix the root cause instead

Output ONLY the corrected TypeScript test file. No markdown fences, no explanation outside inline comments.`,
    },
  ];
}

// ── Bug Reproduction Prompt ────────────────────────────────────────────────

/**
 * Builds the prompt for generating a failing Playwright test that reproduces a reported bug.
 * Used in Phase 3 (Agent Feedback Loop).
 * The test SHOULD FAIL until the bug is fixed — that's how we confirm reproduction.
 */
export function buildBugReproductionPrompt(
  interactionSteps: string,
  userExpectation: string,
  domStateAtFlag: string,
  screenshotDescription: string | null,
  targetAppUrl: string,
): AiMessage[] {
  return [
    {
      role: 'system',
      content: BEHAVIORAL_QA_SYSTEM_PROMPT,
    },
    {
      role: 'user',
      content: `A user reported an unexpected behavior in their application. Write a Playwright test that REPRODUCES this bug.

The test should FAIL when the bug is present and PASS when the bug is fixed.

REPORTED ISSUE:
User expectation: "${userExpectation}"
App URL: ${targetAppUrl}

WHAT THE USER DID (in order):
${interactionSteps}

DOM STATE WHEN BUG WAS FLAGGED:
${domStateAtFlag.slice(0, 2000)}

${screenshotDescription ? `VISUAL CONTEXT: ${screenshotDescription}` : ''}

Write a test that:
1. Reproduces the exact sequence of user actions
2. Asserts what the user EXPECTED to happen (this assertion will FAIL because the bug is present)
3. Is as minimal as possible — only the steps needed to trigger the bug

Output ONLY the TypeScript Playwright test file. Ready to run. No explanation.`,
    },
  ];
}

// ── Code Fix Prompt ────────────────────────────────────────────────────────

/**
 * Builds the prompt that asks the AI to analyze a failing test + application source code
 * and propose a targeted, minimal code fix.
 *
 * The AI returns structured JSON with the exact search/replace operations to apply.
 * Using search/replace (rather than full file rewrites) minimizes token usage and
 * reduces the risk of the AI accidentally removing unrelated code.
 */
export function buildCodeFixPrompt(
  failingTestCode: string,
  sourceFileContents: Array<{ filePath: string; content: string }>,
  userExpectation: string,
  targetAppUrl: string,
): AiMessage[] {
  const sourceCodeBlock = sourceFileContents
    .map(sourceFile => `### ${sourceFile.filePath}\n\`\`\`\n${sourceFile.content}\n\`\`\``)
    .join('\n\n');

  return [
    {
      role: 'system',
      content: BEHAVIORAL_QA_SYSTEM_PROMPT,
    },
    {
      role: 'user',
      content: `A user reported a bug in their application. A Playwright test was written to reproduce the bug — the test FAILS because the bug is present. Your job is to fix the application code so the test will PASS.

APP URL: ${targetAppUrl}

WHAT THE USER EXPECTED:
${userExpectation}

FAILING PLAYWRIGHT TEST (this test describes the DESIRED behavior):
\`\`\`typescript
${failingTestCode}
\`\`\`

APPLICATION SOURCE FILES:
${sourceCodeBlock}

Analyze the source code and the test to identify the exact cause of the failure.

Return ONLY a valid JSON object with this exact structure:
{
  "rootCause": "one sentence explaining the exact cause — what is the code doing wrong",
  "fixDescription": "one to three sentences describing what was changed and why",
  "fileChanges": [
    {
      "filePath": "path/relative/to/source/directory/file.tsx",
      "searchText": "exact string to find in the file (include enough surrounding context to be unique — at least 3 lines if possible)",
      "replacementText": "exact string to replace it with"
    }
  ]
}

Rules:
1. searchText MUST be an exact, character-for-character match for text in the source file
2. Make the minimal change necessary — do not refactor or reformat unrelated code
3. Change no more than 3 files
4. Never modify test files
5. Preserve all existing whitespace and indentation in replacementText
6. Return ONLY the JSON object — no explanation, no markdown fences`,
    },
  ];
}

// ── Validation Suite Prompt ────────────────────────────────────────────────

/**
 * Builds the prompt for generating a comprehensive validation test suite after a bug fix.
 * Generates positive tests (the fix works) AND negative tests (similar bugs don't exist nearby).
 */
export function buildValidationSuitePrompt(
  bugDescription: string,
  fixDescription: string,
  reproductionTestCode: string,
  targetAppUrl: string,
): AiMessage[] {
  return [
    {
      role: 'system',
      content: BEHAVIORAL_QA_SYSTEM_PROMPT,
    },
    {
      role: 'user',
      content: `A bug was found and fixed. Write a comprehensive test suite to validate the fix is complete and no regressions were introduced.

BUG THAT WAS FIXED: ${bugDescription}
HOW IT WAS FIXED: ${fixDescription}
APP URL: ${targetAppUrl}

REPRODUCTION TEST (this should now PASS after the fix):
\`\`\`typescript
${reproductionTestCode}
\`\`\`

Write a test suite with:
1. A test confirming the original bug scenario now works correctly (positive test)
2. At least 2 negative tests for related edge cases that might hide similar bugs
   (e.g., if a button wasn't updating totals, also test that removing items updates totals, and that empty cart shows zero)
3. A boundary condition test if applicable

Output a single TypeScript Playwright test file with all tests in one describe() block.
File must be ready to run with \`playwright test\`. No explanation.`,
    },
  ];
}

// ── Spec Generation ────────────────────────────────────────────────────────

/**
 * Builds the prompt that instructs AI to generate a quality `eztest-spec.md`
 * by analyzing the project source code, package.json, and any existing README.
 *
 * The generated spec is the single most important input to EZTest — it anchors
 * every test to a real user expectation rather than an implementation detail.
 * Written from a PRODUCT MANAGER perspective: what does the user want to
 * accomplish, and what does success look like from their seat at the keyboard?
 */
export function buildSpecGenerationPrompt(
  projectName: string,
  packageDescription: string,
  sourceCodeSummaries: Array<{ filePath: string; excerpt: string }>,
  existingReadmeContent: string | null,
): AiMessage[] {
  const sourceCodeBlock = sourceCodeSummaries
    .map(item => `### ${item.filePath}\n\`\`\`\n${item.excerpt}\n\`\`\``)
    .join('\n\n');

  const readmeSection = existingReadmeContent
    ? `\n\nEXISTING README (use as context, do not just copy it):\n${existingReadmeContent}`
    : '';

  return [
    {
      role: 'system',
      content: `You are a senior product manager and QA director writing behavioral acceptance criteria for an automated testing system.

Your job is to analyze application source code and produce a human-readable behavioral specification that answers ONE question: "How does a real user know when this application is working correctly?"

PERSPECTIVE RULES — these are absolute:
1. Write as if you have NEVER seen the source code — only the running application
2. Describe features in terms of what the USER sees, does, and receives — never how it works internally
3. For every feature, define explicit success criteria: what text appears, what changes on screen, what URL changes
4. For every feature, define failure criteria: what should the user see when something goes wrong?
5. Use plain English — this document will be read by an AI that generates tests; be specific about visible outcomes

OUTPUT FORMAT — produce a markdown document with EXACTLY this structure:
# [App Name] — EZTest Behavioral Specification

## Application Overview
[2-3 sentences: what does this app do and who uses it?]

## User Roles
- **[Role Name]**: [what they can do / what they need]

## Features & Expected Outcomes

### Feature: [Feature Name]
**User Goal:** [What is the user trying to accomplish?]
**Happy Path:**
1. User [action] → User sees [visible result]
2. User [action] → User sees [visible result]
**Success Criteria:**
- [ ] [Specific visible outcome, e.g., "A success toast appears with the text 'Saved!'"]
**Failure Cases:**
- If [condition]: user sees [specific error message or UI state]

## Critical User Journeys
### Journey: [Name]
[Step-by-step walkthrough of the most important user path through the app]

## Failure Modes That Are Never Acceptable
[Behaviors that should NEVER happen from a user perspective — blank screens, unhandled errors, silent failures]

Do NOT include class names, function names, state variable names, or any technical jargon.
Be SPECIFIC about visible text — write the actual strings a user would see, not "an error message".`,
    },
    {
      role: 'user',
      content: `Analyze this application and generate a complete eztest-spec.md.

PROJECT NAME: ${projectName}
DESCRIPTION: ${packageDescription || 'No description provided'}${readmeSection}

SOURCE CODE EXCERPTS:
${sourceCodeBlock}

Generate the full eztest-spec.md now. Be thorough — every feature visible in the source code should have explicit success and failure criteria.`,
    },
  ];
}

// ── Test Quality Audit ─────────────────────────────────────────────────────

/**
 * Builds the prompt for the Test Quality Audit — a fourth AI pass that reads
 * all generated tests together and flags any that test implementation details
 * instead of user-visible behavior.
 *
 * Returns structured JSON so the caller can report flagged tests and optionally
 * auto-fix them before writing to disk. This pass exists as a safety net for
 * the (rare) cases where the first three passes still produce code-level assertions.
 */
export function buildTestQualityAuditPrompt(
  generatedTestFiles: Array<{ fileName: string; testCode: string }>,
  appSpecContent: string | null,
): AiMessage[] {
  const testFilesBlock = generatedTestFiles
    .map(testFile => `### FILE: ${testFile.fileName}\n\`\`\`typescript\n${testFile.testCode}\n\`\`\``)
    .join('\n\n');

  const specSection = appSpecContent
    ? `\n\nAPP BEHAVIORAL SPEC (what these tests should be verifying):\n${appSpecContent}`
    : '';

  return [
    {
      role: 'system',
      content: `You are a ruthless QA auditor reviewing Playwright tests. Identify every test that tests CODE rather than SOFTWARE BEHAVIOR.

A test tests CODE if it:
- Calls toHaveBeenCalled(), toHaveBeenCalledWith(), or any spy/mock assertion
- Imports or references source code from the application under test
- Asserts on JavaScript variables, React state, Redux store, or component props
- Uses page.waitForTimeout() — this masks real failures
- Has a test() name describing what code runs instead of what the user experiences
- Has zero assertions on DOM state visible to a human user

A test tests BEHAVIOR if it:
- Asserts on visible DOM elements: text, visibility, URL, form state
- Describes the user's perspective in the test name
- Would remain valid if the entire implementation was rewritten in a different framework

Return ONLY a JSON object with this exact shape — no markdown, no explanation:
{
  "auditSummary": "One sentence summary of overall test quality",
  "passRate": 0-100,
  "flaggedTests": [
    {
      "fileName": "filename.spec.ts",
      "testName": "exact test() name",
      "issue": "specific description of what is wrong",
      "severity": "critical" | "warning",
      "suggestedFix": "specific replacement assertion or test name"
    }
  ],
  "passingTests": ["list of test names that correctly test user behavior"]
}`,
    },
    {
      role: 'user',
      content: `Audit these test files for behavioral quality.${specSection}

TEST FILES:
${testFilesBlock}

Return the JSON audit report now. Be strict — flag any test with even ONE implementation-detail assertion.`,
    },
  ];
}

// ── Behavioral Interview ───────────────────────────────────────────────────

/**
 * Builds the prompt that generates targeted interview questions about the app.
 *
 * The "behavioral interview" captures user intent for edge cases that no static
 * analysis can infer. By asking the developer specific questions about expected
 * visible outcomes, we capture ground-truth expectations that AI cannot derive
 * from source code. This is the mechanism that closes the gap from 90% to 95%.
 */
export function buildInterviewQuestionsPrompt(
  projectName: string,
  sourceCodeSummaries: Array<{ filePath: string; excerpt: string }>,
  existingSpecContent: string | null,
): AiMessage[] {
  const sourceCodeBlock = sourceCodeSummaries
    .map(item => `### ${item.filePath}\n\`\`\`\n${item.excerpt}\n\`\`\``)
    .join('\n\n');

  const specSection = existingSpecContent
    ? `\n\nEXISTING SPEC (already answered — do NOT ask about these):\n${existingSpecContent}`
    : '';

  return [
    {
      role: 'system',
      content: `You are a QA director preparing to test a web application. You need to understand exactly what users should see in specific scenarios — information that cannot be determined from source code alone.

Identify the TOP 10 most important behavioral questions where the EXPECTED OUTCOME is ambiguous from static analysis.

Focus on:
- Form submissions: what exact text/message appears on success? On each validation failure?
- Authentication: what happens after login/logout? Where does the user go?
- Data operations: what confirmation does the user see after save/delete/update?
- Error states: what specific message appears when a network error occurs?
- Empty states: what does the user see when there is no data?
- Permissions: what happens when an unauthorized user tries an action?

Return ONLY a JSON array — no markdown, no explanation:
[
  {
    "id": "q1",
    "feature": "Feature area this question is about",
    "question": "Plain English question about expected user-visible outcome",
    "context": "Why this matters — what test assertion depends on this answer",
    "answerType": "text" | "url" | "message" | "navigation" | "visibility"
  }
]

Ask SPECIFIC questions — not "what happens when the form is submitted?" but "what exact text does the success message show after a user submits the contact form?"`,
    },
    {
      role: 'user',
      content: `Generate 10 behavioral interview questions for this application.

PROJECT: ${projectName}${specSection}

SOURCE CODE:
${sourceCodeBlock}

Return the JSON array of questions now.`,
    },
  ];
}

/**
 * Builds the prompt that merges confirmed interview answers back into the spec
 * and produces high-precision assertion templates for the test generator.
 *
 * Interview answers are treated as GROUND TRUTH — they override any assumption
 * made from static analysis and become the most authoritative signal in EZTest.
 */
export function buildInterviewAnswerPrompt(
  existingSpecContent: string,
  interviewAnswers: Array<{ question: string; answer: string; feature: string }>,
): AiMessage[] {
  const answersBlock = interviewAnswers
    .map((item, index) => `Q${index + 1} [${item.feature}]: ${item.question}\nConfirmed Answer: ${item.answer}`)
    .join('\n\n');

  return [
    {
      role: 'system',
      content: `You are updating a behavioral test specification with confirmed user expectations provided directly by the application owner.

These answers are GROUND TRUTH — they override any assumption made from static analysis.

Merge the confirmed answers into the existing spec: add or update Success Criteria and Failure Cases sections with the EXACT text and behavior described. Return the complete updated spec as a markdown document. Do not remove any existing content — only ADD to it.`,
    },
    {
      role: 'user',
      content: `Update this spec with confirmed behavioral answers.

EXISTING SPEC:
${existingSpecContent}

CONFIRMED BEHAVIORAL ANSWERS:
${answersBlock}

Return the complete updated eztest-spec.md now.`,
    },
  ];
}


// ── Test Plan Generation ───────────────────────────────────────────────────

/**
 * Builds the prompt that generates a human-readable test plan BEFORE writing
 * any test code. The plan shows what will be tested in plain English so the
 * developer can verify EZTest understands their app correctly.
 *
 * Complexity threshold: flows with more than 3 distinct state transitions or
 * that span multiple pages/components are flagged as "high-complexity" and
 * receive extra detail in the plan output.
 */
export function buildTestPlanPrompt(
  projectName: string,
  userFlows: Array<{ flowName: string; flowDescription: string; componentCount: number; hasErrorPath: boolean }>,
  appSpecContent: string | null,
): AiMessage[] {
  const flowsBlock = userFlows
    .map((flow, index) =>
      `${index + 1}. ${flow.flowName} (${flow.componentCount} component${flow.componentCount !== 1 ? 's' : ''}, ${flow.hasErrorPath ? 'has error path' : 'happy path only'})\n   ${flow.flowDescription}`
    )
    .join('\n\n');

  const specSection = appSpecContent
    ? `\n\nAPP BEHAVIORAL SPEC:\n${appSpecContent}`
    : '';

  return [
    {
      role: 'system',
      content: `You are a QA director producing a test plan that will be reviewed by a developer before any tests are written.

The plan must be:
- Written in plain English — no code, no technical jargon
- Brief for straightforward flows (1-2 lines: what the user does, what they should see)
- Detailed ONLY for high-complexity flows (those spanning multiple pages, multiple components, or with 3+ state transitions)
- Honest about uncertainty — flag anything where the expected outcome is ambiguous

COMPLEXITY THRESHOLD: A flow is "high-complexity" if it:
- Spans more than 2 components
- Involves authentication/permissions
- Has more than 3 possible outcome states
- Involves multi-step wizards or async operations

OUTPUT FORMAT — return a markdown document:
# Test Plan: [Project Name]
## Summary
- **Features identified:** N
- **Test scenarios:** N total (N happy path, N edge cases, N failure cases)
- **High-complexity flows:** N (flagged for review below)

## Test Scenarios

### ✅ [Feature Name] — Happy Path
What will be tested: [1 plain-English sentence]
Expected outcome: [what the user sees]

### ⚠️ [Feature Name] — Edge Case  
What will be tested: [1 plain-English sentence]
Expected outcome: [what the user sees]
_Complexity note: [why this is flagged]_

### ❌ [Feature Name] — Failure Case
What will be tested: [what goes wrong]
Expected outcome: [the error message or fallback the user sees]

## 🔍 High-Complexity Flows (Review Before Generating)
[Only include flows that exceed the complexity threshold — full step-by-step breakdown for each]

## ❓ Ambiguous Expectations (Needs Input)
[List any flows where the expected outcome cannot be determined from source code alone — these are candidates for \`eztest interview\`]`,
    },
    {
      role: 'user',
      content: `Generate a test plan for this application.

PROJECT: ${projectName}${specSection}

USER FLOWS IDENTIFIED:
${flowsBlock}

Generate the complete test plan now. Be concise for simple flows — only expand detail for high-complexity ones.`,
    },
  ];
}

// ── Feedback Context Injection ─────────────────────────────────────────────

/**
 * Formats project-specific feedback (selector fixes, confirmed expectations,
 * false positive flags) into a prompt section that EZTest injects into AI
 * requests. This is the mechanism that makes EZTest improve over time.
 */
export function buildFeedbackContextSection(feedbackSummary: string): string {
  if (!feedbackSummary.trim()) { return ''; }
  return `\n\n--- PROJECT HISTORY (IMPORTANT — apply these learnings) ---\n${feedbackSummary}\n---`;
}
