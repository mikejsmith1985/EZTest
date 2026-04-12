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
import type { ComponentAnalysis, UserFlow } from '../shared/types.js';
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
 * How many characters of source code to include per component.
 * Modern AI models support large context windows — 3000 chars was far too small
 * for real components. 8000 chars captures most real-world component files fully.
 * This constant makes the limit easy to adjust without hunting through prompts.
 */
const MAX_SOURCE_CHARS_PER_COMPONENT = 8000;

// ── App Spec Injection Helper ──────────────────────────────────────────────

/**
 * Formats the optional app spec (README / eztest-spec.md) into a prompt section.
 * The app spec is the single biggest quality lever — it gives the AI the business
 * intent of the application, not just what the code does mechanically.
 */
function formatAppSpecSection(appSpec: string | undefined): string {
  if (!appSpec) return '';
  return `\nAPPLICATION SPECIFICATION (what this app is designed to do — use this to understand user goals):
${appSpec.slice(0, 5000)}

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
 */
export function buildUserFlowGenerationPrompt(
  componentAnalyses: ComponentAnalysis[],
  targetAppUrl: string,
  appSpec?: string,
): AiMessage[] {
  // Include richer context per component: elements + key source excerpt
  // Giving the AI more source context produces dramatically better cross-component flows
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

      // Include a meaningful excerpt of the source to give the AI business context
      const sourceExcerpt = analysis.sourceCode.slice(0, 1500);

      return `### ${analysis.componentName}${analysis.routePath ? ` (route: ${analysis.routePath})` : ''}
Elements:
${elementList}
Source excerpt:
\`\`\`
${sourceExcerpt}
\`\`\``;
    })
    .join('\n\n');

  return [
    {
      role: 'system',
      content: BEHAVIORAL_QA_SYSTEM_PROMPT,
    },
    {
      role: 'user',
      content: `Based on these application components, identify the complete set of USER FLOWS to test.
${formatAppSpecSection(appSpec)}
BASE URL: ${targetAppUrl}

COMPONENTS:
${componentSummaries}

A user flow is a sequence of actions a real user takes to accomplish a goal (e.g., "Add item to cart and checkout").

MANDATORY COVERAGE REQUIREMENTS:
For EVERY happy-path flow you identify, you MUST ALSO generate:
1. At least one ERROR-CASE flow: what happens when the action fails? (bad input, unauthorized, network error, server error)
   → The user MUST see a meaningful error message — not a blank screen or a JavaScript exception
2. At least one EDGE-CASE flow: empty state, boundary value, duplicate action, already-completed action
   → These catch the bugs that happy-path testing misses

Flows that only test success scenarios are INCOMPLETE and will be rejected.

Respond with a JSON array of user flows. Each flow:
{
  "flowName": "verb-first description of what the user accomplishes",
  "startingRoute": "/path where this flow begins",
  "flowKind": "happy-path" | "error-case" | "edge-case",
  "steps": [
    {
      "stepDescription": "what the user does",
      "targetElementDescription": "which element they interact with (human-readable, not CSS)",
      "expectedOutcome": "what the user SEES AFTER this step completes — be specific about visible text, element state, or URL",
      "isNavigation": true/false
    }
  ],
  "involvedComponents": ["ComponentName1", "ComponentName2"],
  "testPriority": "critical" | "high" | "medium"
}

Generate:
- ALL critical happy-path flows (the main purpose of the app)
- A corresponding error-case flow for EVERY happy-path flow
- Key edge cases (empty state, validation, boundary conditions, duplicate actions)

Only return a valid JSON array. No markdown, no explanation.`,
    },
  ];
}

// ── Test Code Generation Prompt ────────────────────────────────────────────

/**
 * Builds the prompt that generates actual Playwright test code from a user flow description.
 * This is the final stage — the AI writes TypeScript Playwright tests that assert on
 * real DOM state and user-visible outcomes.
 *
 * @param appSpec - Optional plain-English app description. When present, the AI can use
 *   it to resolve ambiguity about what the "correct" expected outcome is.
 */
export function buildTestCodeGenerationPrompt(
  userFlow: UserFlow,
  targetAppUrl: string,
  appSpec?: string,
): AiMessage[] {
  const stepsDescription = userFlow.steps
    .map((step, stepIndex) => `Step ${stepIndex + 1}: ${step.actionDescription}
  → Expected visible outcome: ${step.expectedOutcome}
  → Navigation: ${step.isNavigation ? 'yes (URL changes)' : 'no'}`)
    .join('\n');

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

STEPS:
${stepsDescription}

REQUIREMENTS:
1. Import from @playwright/test only — no application source imports
2. Use page.getByRole(), page.getByLabel(), page.getByText(), page.getByPlaceholder() for locators
3. EVERY step must have at least one expect() assertion on what the user SEES — not what code executes
4. Use await expect(locator).toBeVisible() / toHaveText() / toBeEnabled() / toHaveURL() etc.
5. Do NOT use page.waitForTimeout() — let Playwright auto-wait
6. For error-case flows: assert the error message is VISIBLE and READABLE to the user
7. For edge-case flows: assert the graceful handling is visible (empty state message, disabled button, etc.)
8. Include a descriptive test name that describes the USER OUTCOME, not the technical operation
9. Apply the SO WHAT rule to every assertion: if the user wouldn't notice it, remove it

Output ONLY the complete TypeScript test file content. No explanation, no markdown fences.
The file should be ready to run with \`playwright test\`.`,
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
