import { describe, expect, test } from "vitest";
import {
  ChromeDevtoolsMcpRuntime,
  buildChromeDevtoolsMcpArgs,
  parseChromeMcpPageList,
} from "../../companion/chrome-devtools-mcp-runtime.ts";
import { buildMcpAgentBridgeProcessOptions } from "../../companion/mcp-agent-bridge.ts";
import { buildPythonBrowserRuntimeProcessOptions } from "../../companion/python-browser-runtime-bridge.ts";

function textToolResult(text: string) {
  return {
    content: [
      {
        type: "text" as const,
        text,
      },
    ],
  };
}

function jsonToolResult(value: unknown) {
  return textToolResult(
    `Script ran on page and returned:\n\`\`\`json\n${JSON.stringify(value)}\n\`\`\``
  );
}

function createConnectionMock(
  handlers: Array<{
    name: string;
    run: (args?: Record<string, unknown>) => ReturnType<typeof textToolResult>;
  }>
) {
  const calls: Array<{ name: string; args?: Record<string, unknown> }> = [];
  return {
    calls,
    connection: {
      async callTool(name: string, args?: Record<string, unknown>) {
        calls.push({ name, args });
        const next = handlers.shift();
        if (!next) {
          throw new Error(`Unexpected tool call: ${name}`);
        }
        expect(name).toBe(next.name);
        return next.run(args);
      },
      registerProgressHandler() {},
      unregisterProgressHandler() {},
      async close() {
        return;
      },
    },
  };
}

describe("ChromeDevtoolsMcpRuntime", () => {
  test("parses page list output from Chrome DevTools MCP", () => {
    expect(
      parseChromeMcpPageList(
        "## Pages\n1: about:blank\n2: https://example.com/ [selected]"
      )
    ).toEqual([
      {
        pageId: 1,
        url: "about:blank",
        selected: false,
      },
      {
        pageId: 2,
        url: "https://example.com/",
        selected: true,
      },
    ]);
  });

  test("builds Chrome DevTools MCP args around the running-browser path by default", () => {
    expect(
      buildChromeDevtoolsMcpArgs({
        CHROME_DEVTOOLS_MCP_AUTO_CONNECT: "1",
      } as NodeJS.ProcessEnv)
    ).toEqual([
      "-y",
      "chrome-devtools-mcp@latest",
      "--no-usage-statistics",
      "--autoConnect",
    ]);
  });

  test("builds the mcp-agent bridge launch command through python -m uv by default", () => {
    const options = buildMcpAgentBridgeProcessOptions(
      {} as NodeJS.ProcessEnv,
      "/tmp/text-fill-v2"
    );

    expect(options.command).toBe("python3");
    expect(options.args).toEqual([
      "-m",
      "uv",
      "run",
      "--with",
      "mcp-agent",
      "--with",
      "temporalio",
      "python",
      "/tmp/text-fill-v2/companion/mcp_agent_bridge.py",
    ]);
  });

  test("builds the python browser runtime launch command through python -m uv by default", () => {
    const options = buildPythonBrowserRuntimeProcessOptions(
      {} as NodeJS.ProcessEnv,
      "/tmp/text-fill-v2"
    );

    expect(options.command).toBe("python3");
    expect(options.args).toEqual([
      "-m",
      "uv",
      "run",
      "--with",
      "mcp-agent",
      "--with",
      "temporalio",
      "--with",
      "openai",
      "--with",
      "anthropic",
      "--with",
      "google-genai",
      "python",
      "/tmp/text-fill-v2/companion/python_browser_runtime.py",
    ]);
  });

  test("prefers the python mcp-agent runtime for health and draft execution when available", async () => {
    let rawMcpUsed = false;
    const healthCalls: Array<void> = [];
    const draftCalls: Array<{
      pageUrl: string;
      fieldTarget: { selector: string; platform?: string };
      generatedText: string;
      verifyText: string;
      targetName?: string;
    }> = [];

    const runtime = new ChromeDevtoolsMcpRuntime({
      connectionFactory: async () => {
        rawMcpUsed = true;
        throw new Error("raw MCP connection should not be used");
      },
      pythonBridgeFactory: async () => ({
        async health() {
          healthCalls.push(undefined);
          return { connected: true };
        },
        async deriveBrowserWorkItems() {
          throw new Error("not used");
        },
        async startGenericBrowserTaskWorkflow() {
          throw new Error("not used");
        },
        async startGenericBrowserQueueWorkflow() {
          throw new Error("not used");
        },
        async startLinkedInConnectBatchWorkflow() {
          throw new Error("not used");
        },
        async getWorkflowStatus() {
          throw new Error("not used");
        },
        async resumeWorkflow() {
          throw new Error("not used");
        },
        async cancelWorkflow() {
          throw new Error("not used");
        },
        async navigateToUrl() {
          throw new Error("not used");
        },
        async insertDraft(args) {
          draftCalls.push(args);
          return {
            summary: `Inserted the approved draft for ${args.targetName}.`,
            metadata: {
              kind: "insert_draft",
            },
          };
        },
        async executeLinkedInConnectBatch() {
          throw new Error("not used");
        },
        async executeAgentTask() {
          throw new Error("not used");
        },
        registerProgressHandler() {},
        unregisterProgressHandler() {},
        async close() {
          return;
        },
      }),
    });

    expect(await runtime.checkAvailability()).toEqual({ connected: true });
    await expect(
      runtime.insertDraft({
        pageUrl: "https://mail.google.com/mail/u/0/#inbox/FMfcgzQabcd",
        fieldTarget: {
          selector: "#composer",
          platform: "gmail",
        },
        generatedText: "Hi Taylor,\n\nThanks for following up here.",
        verifyText: "Thanks for following up here.",
        targetName: "Taylor Recruiter",
        providerConfig: {
          provider: "openai",
          apiKey: "test-key",
          model: "gpt-5-nano",
        },
      })
    ).resolves.toMatchObject({
      summary: "Inserted the approved draft for Taylor Recruiter.",
    });

    expect(healthCalls).toHaveLength(1);
    expect(draftCalls).toHaveLength(1);
    expect(draftCalls[0]?.fieldTarget.selector).toBe("#composer");
    expect(rawMcpUsed).toBe(false);

    await runtime.dispose();
  });

  test("delegates safe navigation to the python mcp-agent runtime when available", async () => {
    const navigateCalls: Array<{
      targetUrl: string;
      currentPageUrl?: string;
      targetLabel?: string;
    }> = [];

    const runtime = new ChromeDevtoolsMcpRuntime({
      connectionFactory: async () => {
        throw new Error("raw MCP connection should not be used");
      },
      pythonBridgeFactory: async () => ({
        async health() {
          return { connected: true };
        },
        async deriveBrowserWorkItems() {
          throw new Error("not used");
        },
        async startGenericBrowserTaskWorkflow() {
          throw new Error("not used");
        },
        async startGenericBrowserQueueWorkflow() {
          throw new Error("not used");
        },
        async startLinkedInConnectBatchWorkflow() {
          throw new Error("not used");
        },
        async getWorkflowStatus() {
          throw new Error("not used");
        },
        async resumeWorkflow() {
          throw new Error("not used");
        },
        async cancelWorkflow() {
          throw new Error("not used");
        },
        async navigateToUrl(args) {
          navigateCalls.push(args);
          return {
            summary: "Opened LinkedIn search results for software engineering jobs.",
            metadata: {
              kind: "navigate_to_url",
            },
          };
        },
        async insertDraft() {
          throw new Error("not used");
        },
        async executeLinkedInConnectBatch() {
          throw new Error("not used");
        },
        async executeAgentTask() {
          throw new Error("not used");
        },
        registerProgressHandler() {},
        unregisterProgressHandler() {},
        async close() {
          return;
        },
      }),
    });

    await expect(
      runtime.navigateToUrl({
        currentPageUrl: "https://www.linkedin.com/feed/",
        targetUrl:
          "https://www.linkedin.com/jobs/search/?keywords=software%20engineering",
        targetLabel: "software engineering jobs",
      })
    ).resolves.toMatchObject({
      summary: "Opened LinkedIn search results for software engineering jobs.",
    });

    expect(navigateCalls).toEqual([
      {
        currentPageUrl: "https://www.linkedin.com/feed/",
        targetUrl:
          "https://www.linkedin.com/jobs/search/?keywords=software%20engineering",
        targetLabel: "software engineering jobs",
      },
    ]);

    await runtime.dispose();
  });

  test("falls back to the direct Chrome MCP connection if the python runtime is unavailable", async () => {
    const mock = createConnectionMock([
      {
        name: "list_pages",
        run: () => textToolResult("## Pages\n1: about:blank [selected]"),
      },
    ]);

    const runtime = new ChromeDevtoolsMcpRuntime({
      connectionFactory: async () => mock.connection,
      pythonBridgeFactory: async () => {
        throw new Error("python bridge unavailable");
      },
    });

    await expect(runtime.checkAvailability()).resolves.toEqual({
      connected: true,
    });
    expect(mock.calls).toEqual([
      {
        name: "list_pages",
        args: {},
      },
    ]);

    await runtime.dispose();
  });

  test("maps DevToolsActivePort auto-connect failures to an actionable diagnosis", async () => {
    const runtime = new ChromeDevtoolsMcpRuntime({
      pythonBridgeFactory: async () => ({
        async health() {
          return {
            connected: false,
            error:
              "Could not connect to Chrome. Check if Chrome is running. Cause: Could not find DevToolsActivePort for chrome at /Users/student/Library/Application Support/Google/Chrome/DevToolsActivePort",
          };
        },
        async deriveBrowserWorkItems() {
          throw new Error("not used");
        },
        async startGenericBrowserTaskWorkflow() {
          throw new Error("not used");
        },
        async startGenericBrowserQueueWorkflow() {
          throw new Error("not used");
        },
        async startLinkedInConnectBatchWorkflow() {
          throw new Error("not used");
        },
        async getWorkflowStatus() {
          throw new Error("not used");
        },
        async resumeWorkflow() {
          throw new Error("not used");
        },
        async cancelWorkflow() {
          throw new Error("not used");
        },
        async navigateToUrl() {
          throw new Error("not used");
        },
        async insertDraft() {
          throw new Error("not used");
        },
        async executeLinkedInConnectBatch() {
          throw new Error("not used");
        },
        async executeAgentTask() {
          throw new Error("not used");
        },
        registerProgressHandler() {},
        unregisterProgressHandler() {},
        async close() {
          return;
        },
      }),
    });

    await expect(runtime.checkAvailability()).resolves.toEqual({
      connected: false,
      error: expect.stringContaining("chrome://inspect/#remote-debugging"),
    });

    await runtime.dispose();
  });

  test("delegates LinkedIn connect batch execution to the python mcp-agent runtime when available", async () => {
    const batchCalls: Array<{
      items: Array<{ targetUrl: string; targetName?: string; generatedText?: string }>;
      dailyLimit: number;
      providerConfig: {
        provider: string;
        apiKey: string;
        model: string;
      };
    }> = [];

    const runtime = new ChromeDevtoolsMcpRuntime({
      connectionFactory: async () => {
        throw new Error("raw MCP connection should not be used");
      },
      pythonBridgeFactory: async () => ({
        async health() {
          return { connected: true };
        },
        async deriveBrowserWorkItems() {
          throw new Error("not used");
        },
        async startGenericBrowserTaskWorkflow() {
          throw new Error("not used");
        },
        async startGenericBrowserQueueWorkflow() {
          throw new Error("not used");
        },
        async startLinkedInConnectBatchWorkflow() {
          throw new Error("not used");
        },
        async getWorkflowStatus() {
          throw new Error("not used");
        },
        async resumeWorkflow() {
          throw new Error("not used");
        },
        async cancelWorkflow() {
          throw new Error("not used");
        },
        async navigateToUrl() {
          throw new Error("not used");
        },
        async insertDraft() {
          throw new Error("not used");
        },
        async executeLinkedInConnectBatch(args) {
          batchCalls.push(args);
          return {
            summary: "LinkedIn connect batch finished for 1 target. Sent: 1.",
            metadata: {
              kind: "execute_task_batch",
              batchType: "linkedin_connect",
              itemCount: 1,
              sent: 1,
              skipped: 0,
              failed: 0,
            },
          };
        },
        async executeAgentTask() {
          throw new Error("not used");
        },
        registerProgressHandler() {},
        unregisterProgressHandler() {},
        async close() {
          return;
        },
      }),
    });

    await expect(
      runtime.executeLinkedInConnectBatch({
        items: [
          {
            targetUrl: "https://www.linkedin.com/in/example/",
            targetName: "Example Recruiter",
            generatedText: "Hi Example, I’d love to connect.",
          },
        ],
        dailyLimit: 1,
        providerConfig: {
          provider: "openai",
          apiKey: "test-key",
          model: "gpt-5-nano",
        },
      })
    ).resolves.toMatchObject({
      summary: "LinkedIn connect batch finished for 1 target. Sent: 1.",
    });

    expect(batchCalls).toHaveLength(1);
    expect(batchCalls[0]?.items[0]?.targetUrl).toBe(
      "https://www.linkedin.com/in/example/"
    );
    expect(batchCalls[0]?.dailyLimit).toBe(1);
    expect(batchCalls[0]?.providerConfig.model).toBe("gpt-5-nano");

    await runtime.dispose();
  });

  test("delegates generic browser tasks to the python mcp-agent runtime", async () => {
    const runtime = new ChromeDevtoolsMcpRuntime({
      connectionFactory: async () => {
        throw new Error("raw MCP connection should not be used");
      },
      pythonBridgeFactory: async () => ({
        async health() {
          return { connected: true };
        },
        async deriveBrowserWorkItems() {
          throw new Error("not used");
        },
        async startGenericBrowserTaskWorkflow() {
          throw new Error("not used");
        },
        async startGenericBrowserQueueWorkflow() {
          throw new Error("not used");
        },
        async startLinkedInConnectBatchWorkflow() {
          throw new Error("not used");
        },
        async getWorkflowStatus() {
          throw new Error("not used");
        },
        async resumeWorkflow() {
          throw new Error("not used");
        },
        async cancelWorkflow() {
          throw new Error("not used");
        },
        async navigateToUrl() {
          throw new Error("not used");
        },
        async insertDraft() {
          throw new Error("not used");
        },
        async executeLinkedInConnectBatch() {
          throw new Error("not used");
        },
        async executeAgentTask(args) {
          expect(args.providerConfig.model).toBe("gpt-5-nano");
          expect(args.goal).toBe("Search software engineering jobs in LinkedIn");
          return {
            summary: "Opened LinkedIn jobs search for software engineering.",
            metadata: {
              kind: "execute_agent_task",
            },
          };
        },
        registerProgressHandler() {},
        unregisterProgressHandler() {},
        async close() {
          return;
        },
      }),
    });

    await expect(
      runtime.executeAgentTask({
        providerConfig: {
          provider: "openai",
          apiKey: "test-key",
          model: "gpt-5-nano",
        },
        goal: "Search software engineering jobs in LinkedIn",
        pageUrl: "https://www.linkedin.com/feed/",
        platformHint: "linkedin",
      })
    ).resolves.toMatchObject({
      summary: "Opened LinkedIn jobs search for software engineering.",
    });

    await runtime.dispose();
  });

  test("delegates agent-driven durable work-item discovery to the python mcp-agent runtime", async () => {
    const discoveryCalls: Array<{
      goal: string;
      pageUrl?: string;
      platformHint?: string;
    }> = [];

    const runtime = new ChromeDevtoolsMcpRuntime({
      connectionFactory: async () => {
        throw new Error("raw MCP connection should not be used");
      },
      pythonBridgeFactory: async () => ({
        async health() {
          return { connected: true };
        },
        async deriveBrowserWorkItems(args) {
          discoveryCalls.push({
            goal: args.goal,
            pageUrl: args.pageUrl,
            platformHint: args.platformHint,
          });
          return {
            mode: "queue",
            summary:
              "Discovered repeated actionable job cards from the live page tree.",
            workItems: [
              {
                title: "Job card 1",
                pageUrl: "https://jobs.example.com/1",
              },
              {
                title: "Job card 2",
                pageUrl: "https://jobs.example.com/2",
              },
            ],
          };
        },
        async startGenericBrowserTaskWorkflow() {
          throw new Error("not used");
        },
        async startGenericBrowserQueueWorkflow() {
          throw new Error("not used");
        },
        async startLinkedInConnectBatchWorkflow() {
          throw new Error("not used");
        },
        async getWorkflowStatus() {
          throw new Error("not used");
        },
        async resumeWorkflow() {
          throw new Error("not used");
        },
        async cancelWorkflow() {
          throw new Error("not used");
        },
        async navigateToUrl() {
          throw new Error("not used");
        },
        async insertDraft() {
          throw new Error("not used");
        },
        async executeLinkedInConnectBatch() {
          throw new Error("not used");
        },
        async executeAgentTask() {
          throw new Error("not used");
        },
        registerProgressHandler() {},
        unregisterProgressHandler() {},
        async close() {
          return;
        },
      }),
    });

    await expect(
      runtime.deriveBrowserWorkItems({
        providerConfig: {
          provider: "openai",
          apiKey: "test-key",
          model: "gpt-5-nano",
        },
        goal: "Review the visible jobs and queue the strong matches",
        pageUrl: "https://jobs.example.com/search?q=software+engineer",
        platformHint: "jobs_board",
      })
    ).resolves.toEqual({
      mode: "queue",
      summary: "Discovered repeated actionable job cards from the live page tree.",
      workItems: [
        {
          title: "Job card 1",
          pageUrl: "https://jobs.example.com/1",
        },
        {
          title: "Job card 2",
          pageUrl: "https://jobs.example.com/2",
        },
      ],
    });

    expect(discoveryCalls).toEqual([
      {
        goal: "Review the visible jobs and queue the strong matches",
        pageUrl: "https://jobs.example.com/search?q=software+engineer",
        platformHint: "jobs_board",
      },
    ]);

    await runtime.dispose();
  });

  test("requires the python mcp-agent runtime for approved browser actions", async () => {
    const runtime = new ChromeDevtoolsMcpRuntime({
      pythonBridgeFactory: null,
      connectionFactory: async () => createConnectionMock([]).connection,
    });

    await expect(
      runtime.insertDraft({
        pageUrl: "https://mail.google.com/mail/u/0/#inbox/FMfcgzQabcd",
        fieldTarget: {
          selector: "#composer",
          platform: "gmail",
        },
        generatedText: "Hello",
        verifyText: "Hello",
        providerConfig: {
          provider: "openai",
          apiKey: "test-key",
          model: "gpt-5-nano",
        },
      })
    ).rejects.toThrow(/Python mcp-agent browser runtime is required/);
  });
});
