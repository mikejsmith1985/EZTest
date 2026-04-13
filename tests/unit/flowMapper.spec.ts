/**
 * Unit tests for the Flow Mapper module.
 *
 * Tests that ComponentAnalysis objects are correctly packaged into AI prompts,
 * that AI JSON responses are correctly parsed into UserFlow objects, and that
 * edge cases (invalid JSON, empty arrays) are handled gracefully.
 */
import { test, expect } from '@playwright/test';
import {
  mapComponentAnalysesToUserFlows,
  estimateComponentOutputTokens,
  splitIntoDynamicBatches,
} from '../../src/synthesizer/flowMapper.js';
import type { ComponentAnalysis } from '../../src/shared/types.js';
import type { AiClient } from '../../src/shared/aiClient.js';

// ── Test Fixtures ──────────────────────────────────────────────────────────

function createMockComponentAnalysis(
  componentName: string,
  routePath?: string,
): ComponentAnalysis {
  return createMockComponentWithElements(componentName, 1, routePath);
}

/**
 * Creates a mock ComponentAnalysis with a specified number of interactive elements.
 * Used to test dynamic batch sizing, which depends on element count.
 */
function createMockComponentWithElements(
  componentName: string,
  elementCount: number,
  routePath?: string,
): ComponentAnalysis {
  const interactiveElements = Array.from({ length: elementCount }, (_, elementIndex) => ({
    elementKind: 'button' as const,
    textContent: `Action ${elementIndex + 1}`,
    handlerName: `handleAction${elementIndex + 1}`,
  }));

  return {
    filePath: `/src/components/${componentName}.tsx`,
    componentName,
    interactiveElements,
    routePath,
    importedComponents: [],
    detectedFramework: 'react' as const,
    sourceCode: `export function ${componentName}() { return <div />; }`,
  };
}

/** Sample AI response for user flow generation — a valid JSON array of flows. */
const SAMPLE_FLOW_GENERATION_RESPONSE = JSON.stringify([
  {
    flowName: 'User completes checkout',
    startingRoute: '/checkout',
    flowKind: 'happy-path',
    steps: [
      {
        stepDescription: 'Click the Submit Order button',
        targetElementDescription: 'Submit Order button',
        expectedOutcome: 'Order confirmation page appears',
        isNavigation: true,
      },
    ],
    involvedComponents: ['CheckoutForm'],
    testPriority: 'critical',
  },
  {
    flowName: 'User sees error when submitting empty form',
    startingRoute: '/checkout',
    flowKind: 'error-case',
    steps: [
      {
        stepDescription: 'Click Submit without filling required fields',
        targetElementDescription: 'Submit Order button',
        expectedOutcome: 'Validation error messages appear',
        isNavigation: false,
      },
    ],
    involvedComponents: ['CheckoutForm'],
    testPriority: 'high',
  },
]);

// ── Helpers ────────────────────────────────────────────────────────────────

/**
 * Creates a mock AiClient that returns a predetermined response.
 * The `callCount` ref tracks how many times the AI was called.
 */
function createMockAiClient(responseContent: string, callCount = { value: 0 }): AiClient {
  return {
    chat: async () => {
      callCount.value++;
      return { content: responseContent, tokensUsed: 100, modelUsed: 'mock' };
    },
    initialize: async () => {},
    providerName: 'mock',
    modelName: 'mock',
  } as unknown as AiClient;
}

// ── Tests ──────────────────────────────────────────────────────────────────

test.describe('mapComponentAnalysesToUserFlows', () => {
  test('returns an empty array when the AI returns invalid JSON', async () => {
    const mockAiClient = createMockAiClient('this is not valid json');
    const components = [createMockComponentAnalysis('CheckoutForm')];

    const userFlows = await mapComponentAnalysesToUserFlows(components, mockAiClient, {
      targetAppUrl: 'http://localhost:3000',
      shouldAnalyzeIndividualComponents: false,
    });

    expect(userFlows).toEqual([]);
  });

  test('returns an empty array when the AI returns a non-array JSON value', async () => {
    const mockAiClient = createMockAiClient('{"error": "no flows found"}');
    const components = [createMockComponentAnalysis('CheckoutForm')];

    const userFlows = await mapComponentAnalysesToUserFlows(components, mockAiClient, {
      targetAppUrl: 'http://localhost:3000',
      shouldAnalyzeIndividualComponents: false,
    });

    expect(userFlows).toEqual([]);
  });

  test('parses AI response into UserFlow objects with correct flow names', async () => {
    const mockAiClient = createMockAiClient(SAMPLE_FLOW_GENERATION_RESPONSE);
    const components = [createMockComponentAnalysis('CheckoutForm', '/checkout')];

    const userFlows = await mapComponentAnalysesToUserFlows(components, mockAiClient, {
      targetAppUrl: 'http://localhost:3000',
      shouldAnalyzeIndividualComponents: false,
    });

    expect(userFlows).toHaveLength(2);
    expect(userFlows[0].flowName).toBe('User completes checkout');
    expect(userFlows[1].flowName).toBe('User sees error when submitting empty form');
  });

  test('prepends the base URL to the starting route from AI response', async () => {
    const mockAiClient = createMockAiClient(SAMPLE_FLOW_GENERATION_RESPONSE);
    const components = [createMockComponentAnalysis('CheckoutForm')];

    const userFlows = await mapComponentAnalysesToUserFlows(components, mockAiClient, {
      targetAppUrl: 'http://localhost:3000',
      shouldAnalyzeIndividualComponents: false,
    });

    expect(userFlows[0].startingUrl).toBe('http://localhost:3000/checkout');
  });

  test('preserves an absolute starting URL returned by the AI', async () => {
    const forgeFlowResponse = JSON.stringify([
      {
        flowName: 'User opens the Forge app',
        startingRoute: 'https://mikejsmith1985.atlassian.net/jira/software/projects/ACRP/apps/example',
        flowKind: 'happy-path',
        steps: [
          {
            stepDescription: 'Open the Jira project page',
            targetElementDescription: 'Reports tab',
            expectedOutcome: 'Forge app loads',
            isNavigation: true,
          },
        ],
        involvedComponents: ['ReportsHub'],
        testPriority: 'critical',
      },
    ]);
    const mockAiClient = createMockAiClient(forgeFlowResponse);
    const components = [createMockComponentAnalysis('ReportsHub')];

    const userFlows = await mapComponentAnalysesToUserFlows(components, mockAiClient, {
      targetAppUrl: 'https://mikejsmith1985.atlassian.net',
      shouldAnalyzeIndividualComponents: false,
    });

    expect(userFlows[0].startingUrl).toBe('https://mikejsmith1985.atlassian.net/jira/software/projects/ACRP/apps/example');
  });

  test('preserves flow kind from AI response (happy-path, error-case, edge-case)', async () => {
    const mockAiClient = createMockAiClient(SAMPLE_FLOW_GENERATION_RESPONSE);
    const components = [createMockComponentAnalysis('CheckoutForm')];

    const userFlows = await mapComponentAnalysesToUserFlows(components, mockAiClient, {
      targetAppUrl: 'http://localhost:3000',
      shouldAnalyzeIndividualComponents: false,
    });

    expect(userFlows[0].flowKind).toBe('happy-path');
    expect(userFlows[1].flowKind).toBe('error-case');
  });

  test('converts AI steps into UserFlowStep objects with correct fields', async () => {
    const mockAiClient = createMockAiClient(SAMPLE_FLOW_GENERATION_RESPONSE);
    const components = [createMockComponentAnalysis('CheckoutForm')];

    const userFlows = await mapComponentAnalysesToUserFlows(components, mockAiClient, {
      targetAppUrl: 'http://localhost:3000',
      shouldAnalyzeIndividualComponents: false,
    });

    const firstStep = userFlows[0].steps[0];
    expect(firstStep.actionDescription).toBe('Click the Submit Order button');
    expect(firstStep.expectedOutcome).toBe('Order confirmation page appears');
    expect(firstStep.isNavigation).toBe(true);
  });

  test('skips per-component intent analysis when shouldAnalyzeIndividualComponents is false', async () => {
    const aiCallCount = { value: 0 };
    const mockAiClient = createMockAiClient(SAMPLE_FLOW_GENERATION_RESPONSE, aiCallCount);
    const components = [
      createMockComponentAnalysis('ComponentA'),
      createMockComponentAnalysis('ComponentB'),
      createMockComponentAnalysis('ComponentC'),
    ];

    await mapComponentAnalysesToUserFlows(components, mockAiClient, {
      targetAppUrl: 'http://localhost:3000',
      shouldAnalyzeIndividualComponents: false,
    });

    // Only 1 AI call: the flow generation call (no per-component calls)
    expect(aiCallCount.value).toBe(1);
  });

  test('handles AI response wrapped in markdown code fences', async () => {
    const fencedResponse = `\`\`\`json\n${SAMPLE_FLOW_GENERATION_RESPONSE}\n\`\`\``;
    const mockAiClient = createMockAiClient(fencedResponse);
    const components = [createMockComponentAnalysis('CheckoutForm')];

    const userFlows = await mapComponentAnalysesToUserFlows(components, mockAiClient, {
      targetAppUrl: 'http://localhost:3000',
      shouldAnalyzeIndividualComponents: false,
    });

    // Should still parse correctly despite the fences
    expect(userFlows.length).toBeGreaterThan(0);
  });
});

// ── estimateComponentOutputTokens ─────────────────────────────────────────

test.describe('estimateComponentOutputTokens', () => {
  test('returns at least 660 tokens for a component with 0 elements (1 logical flow minimum)', () => {
    const component = createMockComponentWithElements('Empty', 0);
    // 1 logical flow × 3 variants × 220 tokens = 660
    expect(estimateComponentOutputTokens(component)).toBe(660);
  });

  test('returns 660 tokens for a component with 1 element', () => {
    const component = createMockComponentWithElements('SingleButton', 1);
    // ceil(1/2) = 1 logical flow × 3 × 220 = 660
    expect(estimateComponentOutputTokens(component)).toBe(660);
  });

  test('returns 1320 tokens for a component with 3 elements', () => {
    const component = createMockComponentWithElements('SmallForm', 3);
    // ceil(3/2) = 2 logical flows × 3 × 220 = 1320
    expect(estimateComponentOutputTokens(component)).toBe(1320);
  });

  test('returns proportionally more tokens for more elements', () => {
    const simpleComponent = createMockComponentWithElements('Simple', 1);
    const complexComponent = createMockComponentWithElements('Complex', 10);
    expect(estimateComponentOutputTokens(complexComponent)).toBeGreaterThan(
      estimateComponentOutputTokens(simpleComponent),
    );
  });
});

// ── splitIntoDynamicBatches ────────────────────────────────────────────────

test.describe('splitIntoDynamicBatches', () => {
  test('returns a single batch when total estimated tokens fit within the budget', () => {
    // 4 simple components × 660 tokens each = 2640 + 200 overhead = 2840 — fits in 3600
    const components = Array.from({ length: 4 }, (_, i) =>
      createMockComponentWithElements(`Component${i}`, 1),
    );
    const batches = splitIntoDynamicBatches(components);
    expect(batches).toHaveLength(1);
    expect(batches[0]).toHaveLength(4);
  });

  test('splits into multiple batches when components exceed the token budget', () => {
    // 6 complex components × ceil(8/2)*3*220 = 6 × 2640 = 15840 tokens — needs multiple batches
    const components = Array.from({ length: 6 }, (_, i) =>
      createMockComponentWithElements(`BigForm${i}`, 8),
    );
    const batches = splitIntoDynamicBatches(components);
    expect(batches.length).toBeGreaterThan(1);
    // Every component must appear in exactly one batch
    expect(batches.flat()).toHaveLength(6);
  });

  test('places a single oversized component in its own batch rather than dropping it', () => {
    // One massive component that alone exceeds the budget
    const hugeComponent = createMockComponentWithElements('MegaForm', 30);
    const batches = splitIntoDynamicBatches([hugeComponent]);
    expect(batches).toHaveLength(1);
    expect(batches[0]).toHaveLength(1);
  });

  test('returns an empty array for an empty input', () => {
    expect(splitIntoDynamicBatches([])).toEqual([]);
  });

  test('preserves component order across batches', () => {
    const components = Array.from({ length: 8 }, (_, i) =>
      createMockComponentWithElements(`Form${i}`, 6),
    );
    const batches = splitIntoDynamicBatches(components);
    const allInOrder = batches.flat().map(component => component.componentName);
    const expectedOrder = components.map(component => component.componentName);
    expect(allInOrder).toEqual(expectedOrder);
  });

  test('no batch exceeds TARGET_BATCH_OUTPUT_TOKENS unless a single component forces it', () => {
    // Mix of simple and complex components
    const components = [
      createMockComponentWithElements('Nav', 1),
      createMockComponentWithElements('LoginForm', 6),
      createMockComponentWithElements('Dashboard', 2),
      createMockComponentWithElements('ProfileForm', 8),
      createMockComponentWithElements('Footer', 1),
    ];
    const batches = splitIntoDynamicBatches(components);
    const TOKEN_BUDGET = 3600;
    const OVERHEAD = 200;
    for (const batch of batches) {
      const batchTokens = batch.reduce(
        (total, component) => total + estimateComponentOutputTokens(component),
        OVERHEAD,
      );
      // Either within budget, or it's a single component that alone exceeded the budget
      const isWithinBudget = batchTokens <= TOKEN_BUDGET;
      const isForcedSingleComponent = batch.length === 1;
      expect(isWithinBudget || isForcedSingleComponent).toBe(true);
    }
  });
});
