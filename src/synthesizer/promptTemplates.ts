/**
 * AI Prompt Templates for EZTest.
 *
 * These prompts are the most important part of EZTest — they are carefully designed
 * to instruct the AI to think like a QA engineer testing from a USER perspective,
 * NOT like a developer testing code structure. Every word in these prompts matters.
 *
 * Key principles enforced in all prompts:
 * 1. Assert on DOM state and user-visible outcomes, NOT function calls or internal state
 * 2. Use accessible selectors (role, label, text) over brittle CSS class selectors
 * 3. Think about what a real user would see and do, not what the code does internally
 * 4. Always include: happy path + at least one error case + at least one edge case
 */
import type { ComponentAnalysis, UserFlow } from '../shared/types.js';
import type { AiMessage } from '../shared/types.js';

// ── System Prompts ─────────────────────────────────────────────────────────

/**
 * The base system prompt injected into every AI conversation in EZTest.
 * Establishes the AI's role as a behavioral QA engineer.
 */
const BEHAVIORAL_QA_SYSTEM_PROMPT = `You are a senior QA engineer writing Playwright end-to-end tests.

Your job is to test applications from a USER'S perspective — what they see, what they click, and what they expect to happen — NOT from a developer's perspective.

CRITICAL RULES for the tests you write:
1. NEVER assert that a function was called (no toHaveBeenCalled, no mock assertions)
2. ALWAYS assert on what the USER SEES: text appearing, elements being visible/hidden, URLs changing, form values updating
3. Use Playwright's role-based locators first: getByRole(), getByLabel(), getByText(), getByPlaceholder()
4. Only use CSS selectors or data-testid as a LAST resort when semantic locators are not available
5. Write tests that would FAIL if the feature is broken and PASS if it works correctly
6. Always await Playwright's auto-waiting locators — never add arbitrary sleep() calls
7. Include assertions that confirm BOTH the action succeeded AND side effects occurred (e.g., a form submitting should assert the success message appeared AND the form is gone)
`;

// ── Component Intent Analysis Prompt ──────────────────────────────────────

/**
 * Builds the prompt that asks the AI to interpret a component's user-facing purpose.
 * The AI reads the component source and describes what a user can DO with it,
 * without referencing any implementation details.
 */
export function buildComponentIntentPrompt(analysis: ComponentAnalysis): AiMessage[] {
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

  return [
    {
      role: 'system',
      content: BEHAVIORAL_QA_SYSTEM_PROMPT,
    },
    {
      role: 'user',
      content: `Analyze this component and describe what a USER can do with it.

COMPONENT NAME: ${analysis.componentName}
ROUTE: ${analysis.routePath ?? 'unknown'}
FRAMEWORK: ${analysis.detectedFramework}

INTERACTIVE ELEMENTS FOUND:
${elementSummary}

SOURCE CODE:
\`\`\`${analysis.detectedFramework === 'react' ? 'tsx' : 'html'}
${analysis.sourceCode.slice(0, 3000)}
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
 */
export function buildUserFlowGenerationPrompt(
  componentAnalyses: ComponentAnalysis[],
  targetAppUrl: string,
): AiMessage[] {
  const componentSummaries = componentAnalyses
    .map(analysis => {
      const elementList = analysis.interactiveElements
        .slice(0, 10) // Limit per component to manage token count
        .map(element => {
          const label = element.textContent ?? element.ariaLabel ?? element.handlerName ?? element.elementKind;
          return `  - ${element.elementKind}: "${label}"`;
        })
        .join('\n');

      return `### ${analysis.componentName}${analysis.routePath ? ` (route: ${analysis.routePath})` : ''}
${elementList}`;
    })
    .join('\n\n');

  return [
    {
      role: 'system',
      content: BEHAVIORAL_QA_SYSTEM_PROMPT,
    },
    {
      role: 'user',
      content: `Based on these application components, identify the most important USER FLOWS to test.

BASE URL: ${targetAppUrl}

COMPONENTS:
${componentSummaries}

A user flow is a sequence of actions a real user would take to accomplish a goal (e.g., "Add item to cart and checkout", "Register a new account", "Edit and save profile settings").

Respond with a JSON array of user flows. Each flow:
{
  "flowName": "verb-first description of what the user accomplishes",
  "startingRoute": "/path where this flow begins",
  "flowKind": "happy-path" | "error-case" | "edge-case",
  "steps": [
    {
      "stepDescription": "what the user does",
      "targetElementDescription": "which element they interact with (use human-readable description, not CSS)",
      "expectedOutcome": "what the user sees AFTER this step completes",
      "isNavigation": true/false
    }
  ],
  "involvedComponents": ["ComponentName1", "ComponentName2"],
  "testPriority": "critical" | "high" | "medium"
}

Generate:
- ALL critical happy-path flows (the main thing the app does)
- The most important error cases (what happens when things go wrong)
- Key edge cases (empty states, validation errors, boundary conditions)

Only return a valid JSON array. No markdown, no explanation.`,
    },
  ];
}

// ── Test Code Generation Prompt ────────────────────────────────────────────

/**
 * Builds the prompt that generates actual Playwright test code from a user flow description.
 * This is the final stage — the AI writes TypeScript Playwright tests that assert on
 * real DOM state and user-visible outcomes.
 */
export function buildTestCodeGenerationPrompt(
  userFlow: UserFlow,
  targetAppUrl: string,
): AiMessage[] {
  const stepsDescription = userFlow.steps
    .map((step, stepIndex) => `Step ${stepIndex + 1}: ${step.actionDescription}
  → Expected: ${step.expectedOutcome}
  → Navigation: ${step.isNavigation ? 'yes' : 'no'}`)
    .join('\n');

  return [
    {
      role: 'system',
      content: BEHAVIORAL_QA_SYSTEM_PROMPT,
    },
    {
      role: 'user',
      content: `Write a complete Playwright TypeScript test for this user flow.

FLOW: ${userFlow.flowName}
KIND: ${userFlow.flowKind}
BASE URL: ${targetAppUrl}
STARTING PATH: ${userFlow.startingUrl}

STEPS:
${stepsDescription}

REQUIREMENTS:
1. Import from @playwright/test
2. Use page.getByRole(), page.getByLabel(), page.getByText(), page.getByPlaceholder() for locators
3. Every step must have at least one expect() assertion on what the user SEES
4. Use await expect(locator).toBeVisible() / toHaveText() / toBeEnabled() etc.
5. Do NOT use page.waitForTimeout() — let Playwright auto-wait
6. If this is an error-case flow, assert the error message is visible to the user
7. Include a descriptive test name in the it() / test() block
8. Handle authentication by navigating to the starting URL after login if needed

Output ONLY the complete TypeScript test file content. No explanation, no markdown fences.
The file should be ready to run with \`playwright test\`.`,
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
