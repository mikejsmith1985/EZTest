/**
 * Unit tests for the Flow Mapper module.
 *
 * Tests that ComponentAnalysis objects are correctly packaged into AI prompts,
 * that AI JSON responses are correctly parsed into UserFlow objects, and that
 * edge cases (invalid JSON, empty arrays) are handled gracefully.
 */
import { test, expect } from '@playwright/test';
import { mapComponentAnalysesToUserFlows } from '../../src/synthesizer/flowMapper.js';
import type { ComponentAnalysis } from '../../src/shared/types.js';
import type { AiClient } from '../../src/shared/aiClient.js';

// ── Test Fixtures ──────────────────────────────────────────────────────────

function createMockComponentAnalysis(
  componentName: string,
  routePath?: string,
): ComponentAnalysis {
  return {
    filePath: `/src/components/${componentName}.tsx`,
    componentName,
    interactiveElements: [
      {
        elementKind: 'button',
        textContent: 'Submit Order',
        handlerName: 'handleSubmit',
      },
    ],
    routePath,
    importedComponents: [],
    detectedFramework: 'react',
    sourceCode: `export function ${componentName}() { return <button onClick={handleSubmit}>Submit Order</button>; }`,
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
