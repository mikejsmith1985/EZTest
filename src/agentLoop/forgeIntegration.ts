/**
 * Forge Terminal Integration — sends bug reports to the Forge Terminal agent
 * and orchestrates the autonomous test-generation → fix → validation loop.
 *
 * When a bug report arrives, this module:
 * 1. Formats the report into a rich agent prompt
 * 2. Sends it to Forge Terminal using the best available delivery method:
 *    a) MCP server (POST /api/mcp with task_submit tool) — preferred
 *    b) Webhook (POST to forgeTerminalWebhookUrl) — fallback
 *    c) File (write .forge/pending-tasks/*.md) — last resort
 * 3. The agent picks it up and runs through: failing test → code fix → validation suite
 */
import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { BugReport } from '../shared/types.js';
import { formatInteractionHistoryForPrompt } from '../recorder/bugReportBuilder.js';
import { logInfo, logSuccess, logWarning, logDebug } from '../shared/logger.js';

// ── Prompt Formatting ──────────────────────────────────────────────────────

/**
 * Formats a BugReport into a complete agent prompt.
 * The prompt is designed to give the agent everything it needs without
 * requiring any follow-up questions.
 */
function formatBugReportAsAgentPrompt(bugReport: BugReport, sourceDirectory?: string): string {
  const interactionSteps = formatInteractionHistoryForPrompt(bugReport.interactionHistory);

  return `# EZTest Bug Report — Action Required

**Report ID:** ${bugReport.reportId}
**Reported:** ${bugReport.reportedAt}
**URL:** ${bugReport.observedAtUrl}

## What the User Expected
> ${bugReport.userExpectation}

## What the User Did (in order)
${interactionSteps}

## Application State When Bug Was Flagged
\`\`\`html
${bugReport.domStateAtFlag.slice(0, 3000)}
\`\`\`

${sourceDirectory ? `## Source Code Location\n${sourceDirectory}` : ''}

---

## Your Task

Please complete the following steps in order:

### Step 1: Write a Failing Test
Write a Playwright test that reproduces this bug. The test should:
- Follow the exact interaction sequence above
- Assert what the user EXPECTED to happen (this assertion will FAIL because the bug is present)
- Be as minimal as possible

Run the test to confirm it fails. **Do not proceed until the test fails.**

### Step 2: Find and Fix the Bug
Analyze the source code to find what is causing the unexpected behavior. Apply a fix.

### Step 3: Validate the Fix
1. Run the reproduction test — it should now PASS
2. Generate and run a validation suite with:
   - At least 2 positive tests confirming the fix works
   - At least 2 negative tests for related edge cases
   - All tests must pass before this task is complete

### Step 4: Summary
Provide a brief summary of: what the bug was, what caused it, and how it was fixed.
`;
}

// ── Delivery Methods ───────────────────────────────────────────────────────

/**
 * Delivers the bug report via the Forge Terminal MCP server (task_submit tool).
 * This is the preferred method — it provides acknowledgement and a task ID.
 * Returns the task ID on success, or null on failure.
 */
async function deliverViaMcp(
  agentPrompt: string,
  bugReport: BugReport,
  mcpUrl: string,
  mcpToken: string,
): Promise<string | null> {
  const rpcRequest = {
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/call',
    params: {
      name: 'task_submit',
      arguments: {
        type: 'bug-report',
        payload: agentPrompt,
        source: 'eztest-mcp',
      },
    },
  };

  try {
    const response = await fetch(mcpUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${mcpToken}`,
      },
      body: JSON.stringify(rpcRequest),
    });

    if (!response.ok) {
      logWarning(`Forge MCP server returned ${response.status}. Falling back.`);
      return null;
    }

    const responseBody = await response.json() as {
      result?: { content?: Array<{ text?: string }> };
      error?: { message?: string };
    };

    if (responseBody.error) {
      logWarning(`Forge MCP error: ${responseBody.error.message ?? 'unknown error'}`);
      return null;
    }

    // Parse the task ID from the JSON text content.
    const contentText = responseBody.result?.content?.[0]?.text ?? '';
    try {
      const taskResponse = JSON.parse(contentText) as { taskId?: string };
      if (taskResponse.taskId) {
        logSuccess(`Bug report delivered to Forge via MCP — task ID: ${taskResponse.taskId}`);
        logInfo(`Monitor progress: GET ${mcpUrl}/tasks/${taskResponse.taskId}`);
        return taskResponse.taskId;
      }
    } catch {
      // Content was not JSON — fall through with a generic success.
    }

    logSuccess(`Bug report ${bugReport.reportId} delivered to Forge via MCP.`);
    return 'delivered';
  } catch (fetchError) {
    logWarning(`Could not reach Forge MCP server at ${mcpUrl}: ${String(fetchError)}`);
    return null;
  }
}

/**
 * Delivers the agent prompt via HTTP webhook to a running Forge Terminal instance.
 */
async function deliverViaWebhook(
  agentPrompt: string,
  bugReport: BugReport,
  webhookUrl: string,
): Promise<boolean> {
  try {
    const response = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: 'eztest-bug-report',
        reportId: bugReport.reportId,
        prompt: agentPrompt,
        timestamp: bugReport.reportedAt,
      }),
    });

    if (response.ok) {
      logSuccess(`Bug report delivered to Forge Terminal webhook (${webhookUrl})`);
      return true;
    } else {
      logWarning(`Webhook returned ${response.status}. Falling back to file delivery.`);
      return false;
    }
  } catch (fetchError) {
    logWarning(`Could not reach Forge Terminal webhook: ${String(fetchError)}`);
    logWarning('Falling back to file-based delivery.');
    return false;
  }
}

/**
 * Delivers the agent prompt by writing a markdown file to .forge/pending-tasks/.
 * Forge Terminal monitors this directory for new tasks.
 */
function deliverViaFile(
  agentPrompt: string,
  bugReport: BugReport,
  workingDirectory: string,
): string {
  const pendingTasksDirectory = resolve(workingDirectory, '.forge', 'pending-tasks');
  if (!existsSync(pendingTasksDirectory)) {
    mkdirSync(pendingTasksDirectory, { recursive: true });
  }

  const taskFileName = `bug-report-${bugReport.reportId}.md`;
  const taskFilePath = join(pendingTasksDirectory, taskFileName);

  writeFileSync(taskFilePath, agentPrompt, 'utf-8');
  logSuccess(`Bug report written to: ${taskFilePath}`);
  logInfo('Forge Terminal will pick this up automatically if monitoring is enabled.');
  logInfo('Or copy the task content and paste it into Forge Terminal manually.');

  return taskFilePath;
}

// ── Public API ─────────────────────────────────────────────────────────────

/** Options for sending a bug report to the agent. */
export interface ForgeIntegrationOptions {
  /** URL of the Forge Terminal MCP server (e.g. http://localhost:3005/api/mcp). Preferred. */
  mcpUrl?: string;
  /** Bearer token for the Forge Terminal MCP server (from ~/.forge/mcp-token). */
  mcpToken?: string;
  /** URL of the Forge Terminal webhook. Used when MCP URL is not configured. */
  webhookUrl?: string;
  /** The working directory of the target project (where .forge/ lives). */
  projectWorkingDirectory: string;
  /** The source code directory for the agent to analyze. */
  sourceDirectory?: string;
}

/**
 * Sends a BugReport to the Forge Terminal agent using the best available delivery method.
 *
 * Priority order:
 *   1. MCP task_submit (acknowledged, returns task ID) — requires mcpUrl + mcpToken
 *   2. HTTP webhook (fire-and-forget) — requires webhookUrl
 *   3. File drop to .forge/pending-tasks/ — always available as last resort
 */
export async function sendBugReportToForgeAgent(
  bugReport: BugReport,
  options: ForgeIntegrationOptions,
): Promise<void> {
  const { mcpUrl, mcpToken, webhookUrl, projectWorkingDirectory, sourceDirectory } = options;

  const agentPrompt = formatBugReportAsAgentPrompt(bugReport, sourceDirectory);

  logDebug(`Sending bug report ${bugReport.reportId} to Forge Terminal agent...`);

  // Priority 1: MCP task_submit
  if (mcpUrl && mcpToken) {
    const taskId = await deliverViaMcp(agentPrompt, bugReport, mcpUrl, mcpToken);
    if (taskId) return;
  } else if (mcpUrl) {
    logWarning('forgeMcpUrl is set but forgeMcpToken is missing — skipping MCP delivery.');
  }

  // Priority 2: HTTP webhook
  if (webhookUrl) {
    const wasWebhookSuccessful = await deliverViaWebhook(agentPrompt, bugReport, webhookUrl);
    if (wasWebhookSuccessful) return;
  }

  // Priority 3: File fallback
  deliverViaFile(agentPrompt, bugReport, projectWorkingDirectory);
}
