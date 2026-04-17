from __future__ import annotations

import asyncio
import os
import sys
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

ROOT_DIR = Path(__file__).resolve().parents[2]
if str(ROOT_DIR) not in sys.path:
    sys.path.insert(0, str(ROOT_DIR))

from companion.python_browser_runtime import (
    PythonBrowserRuntime,
    build_settings,
    build_retry_resume_context,
    build_resume_signal_context,
    build_effective_system_prompt,
    extract_json_payload,
    is_linkedin_profile_connect_goal,
    merge_resume_signal_payload,
)
from mcp_agent.app import MCPApp


class FakeLLM:
    def __init__(self, responses: list[str]):
        self._responses = list(responses)
        self.prompts: list[str] = []

    async def generate_str(self, prompt, _params):
        self.prompts.append(prompt)
        if not self._responses:
            raise AssertionError("No fake LLM response queued")
        return self._responses.pop(0)


class FakeOrchestrator:
    def __init__(self, *, result: str, step_results: list[object]):
        self.result = result
        self.step_results = step_results
        self.prompts: list[str] = []

    async def execute(self, prompt, _params):
        self.prompts.append(prompt)
        return SimpleNamespace(result=self.result, step_results=self.step_results)


class StubPythonBrowserRuntime(PythonBrowserRuntime):
    def __init__(
        self,
        llm: FakeLLM,
        page_state: dict[str, object],
        orchestrator: object | None = None,
        app: MCPApp | None = None,
    ):
        super().__init__(agent=SimpleNamespace(context=getattr(app, "context", None)), app=app)
        self._llm = llm
        self._page_state = page_state
        self._orchestrator = orchestrator

    async def attach_augmented_llm(self, provider_config, instruction):
        return self._llm, "openai", str(provider_config.get("model") or "gpt-5-nano")

    async def capture_selected_page_state(self) -> dict[str, object]:
        return dict(self._page_state)

    def create_generic_task_orchestrator(self, *, provider, model, system_prompt):
        if self._orchestrator is None:
            raise RuntimeError("orchestrator unavailable in test")
        return self._orchestrator


class ExtractJsonPayloadTests(unittest.TestCase):
    def test_accepts_embedded_json_object(self):
        parsed = extract_json_payload(
            'Task finished.\n```json\n{"summary":"Done","status":"completed"}\n```'
        )

        self.assertEqual(
            parsed,
            {
                "summary": "Done",
                "status": "completed",
            },
        )

    def test_detects_linkedin_profile_connect_goals(self):
        self.assertTrue(
            is_linkedin_profile_connect_goal(
                {
                    "goal": "Please connect this person and write a connection note.",
                    "platformHint": "linkedin",
                    "pageUrl": "https://www.linkedin.com/in/example-person/",
                }
            )
        )
        self.assertFalse(
            is_linkedin_profile_connect_goal(
                {
                    "goal": "Search software engineering jobs on LinkedIn",
                    "platformHint": "linkedin",
                    "pageUrl": "https://www.linkedin.com/jobs/search/",
                }
            )
        )

    def test_appends_saved_system_instructions(self):
        prompt = build_effective_system_prompt(
            "Base instructions.",
            "Keep the tone concise and factual.",
        )

        self.assertIn("Base instructions.", prompt)
        self.assertIn("Additional saved user instructions:", prompt)
        self.assertIn("Keep the tone concise and factual.", prompt)

    def test_build_settings_can_enable_temporal_execution(self):
        with mock.patch.dict(
            os.environ,
            {
                "LOCAL_COMPANION_MCP_AGENT_EXECUTION_ENGINE": "temporal",
                "LOCAL_COMPANION_TEMPORAL_HOST": "127.0.0.1",
                "LOCAL_COMPANION_TEMPORAL_PORT": "7233",
                "LOCAL_COMPANION_TEMPORAL_NAMESPACE": "default",
                "LOCAL_COMPANION_TEMPORAL_TASK_QUEUE": "cheatresume-browser-agent",
            },
            clear=False,
        ):
            settings = build_settings()

        self.assertEqual(settings.execution_engine, "temporal")
        self.assertIsNotNone(settings.temporal)
        self.assertEqual(settings.temporal.host, "127.0.0.1:7233")
        self.assertEqual(settings.temporal.namespace, "default")
        self.assertEqual(settings.temporal.task_queue, "cheatresume-browser-agent")

    def test_build_resume_signal_context_includes_updated_page_state(self):
        context = build_resume_signal_context(
            existing_resume_context="Continue from the filled application form.",
            resume_count=1,
            pause_reason="The submit button could not be found after retries.",
            signal_payload={
                "pageUrl": "https://example.com/apply/step-2",
                "pageContext": "The second application step is visible with profile fields prefilled.",
                "resumeContext": "Do not repeat the profile details step.",
            },
        )

        self.assertIn("Workflow resume cycle 1", context)
        self.assertIn("The submit button could not be found after retries.", context)
        self.assertIn("https://example.com/apply/step-2", context)
        self.assertIn("Do not repeat the profile details step.", context)

    def test_merge_resume_signal_payload_updates_runtime_payload(self):
        merged = merge_resume_signal_payload(
            current_payload={
                "goal": "Finish the application",
                "pageUrl": "https://example.com/apply/step-1",
                "pageContext": "Step 1 of the form.",
                "resumeContext": "The name and email fields are already complete.",
            },
            signal_payload={
                "pageUrl": "https://example.com/apply/step-2",
                "pageContext": "Step 2 is visible.",
                "userContext": "Use the saved work history for answers.",
                "structured": {"data": {"step": "2"}},
                "resumeFile": {
                    "name": "resume.pdf",
                    "mimeType": "application/pdf",
                    "base64": "cGRmLWJ5dGVz",
                },
            },
            pause_reason="Could not locate the continue button.",
            resume_count=2,
        )

        self.assertEqual(merged["pageUrl"], "https://example.com/apply/step-2")
        self.assertEqual(merged["pageContext"], "Step 2 is visible.")
        self.assertEqual(merged["userContext"], "Use the saved work history for answers.")
        self.assertEqual(merged["structured"], {"data": {"step": "2"}})
        self.assertEqual(
            merged["resumeFile"],
            {
                "name": "resume.pdf",
                "mimeType": "application/pdf",
                "base64": "cGRmLWJ5dGVz",
            },
        )
        self.assertIn("Workflow resume cycle 2", str(merged["resumeContext"]))
        self.assertIn("Could not locate the continue button.", str(merged["resumeContext"]))


class RunAgentJsonTaskTests(unittest.IsolatedAsyncioTestCase):
    async def test_uses_iterative_orchestrator_for_generic_browser_tasks(self):
        llm = FakeLLM([])
        orchestrator = FakeOrchestrator(
            result='{"summary":"Completed the multi-step browser task.","status":"completed","finalUrl":"https://example.com/done"}',
            step_results=[
                SimpleNamespace(
                    step=SimpleNamespace(description="Inspect the current page"),
                    result="Verified the current browser state and found the target action.",
                    task_results=[
                        SimpleNamespace(
                            description="Take a fresh page snapshot",
                            result="Confirmed the action button is visible.",
                        )
                    ],
                ),
                SimpleNamespace(
                    step=SimpleNamespace(description="Complete the requested browser action"),
                    result="Completed the requested browser action and verified success.",
                    task_results=[
                        SimpleNamespace(
                            description="Click the action control",
                            result="The browser navigated to the success page.",
                        )
                    ],
                ),
            ],
        )
        runtime = StubPythonBrowserRuntime(
            llm,
            {
                "pageUrl": "https://example.com/start",
                "pageTitle": "Start page",
                "pageSnapshot": "Browser task page",
            },
            orchestrator=orchestrator,
        )

        result = await runtime.run_agent_json_task(
            provider_config={
                "provider": "openai",
                "apiKey": "test-key",
                "model": "gpt-5-nano",
            },
            task_label="generic_browser_task",
            system_prompt="You are a browser control agent.",
            user_prompt="Open the target page and finish the browser task.",
            max_iterations=10,
            max_tokens=1000,
        )

        self.assertEqual(result["summary"], "Completed the multi-step browser task.")
        self.assertEqual(result["status"], "completed")
        self.assertEqual(result["finalUrl"], "https://example.com/done")
        self.assertEqual(len(result["_planSteps"]), 2)
        self.assertEqual(result["_planSteps"][0]["title"], "Inspect the current page")
        self.assertEqual(
            result["_planSteps"][1]["resultSummary"],
            "Completed the requested browser action and verified success.",
        )
        self.assertEqual(result["_executionMode"], "iterative_orchestrator")
        self.assertEqual(llm.prompts, [])
        self.assertEqual(len(orchestrator.prompts), 1)

    async def test_repairs_empty_model_response_with_finalization_pass(self):
        llm = FakeLLM(
            [
                "",
                '{"summary":"Opened Easy Apply flow.","status":"completed","finalUrl":"https://www.linkedin.com/jobs/view/123"}',
            ]
        )
        runtime = StubPythonBrowserRuntime(
            llm,
            {
                "pageUrl": "https://www.linkedin.com/jobs/view/123",
                "pageTitle": "Easy Apply - Software Engineer",
                "pageSnapshot": "Easy Apply dialog is visible with Continue button.",
            },
        )

        result = await runtime.run_agent_json_task(
            provider_config={
                "provider": "openai",
                "apiKey": "test-key",
                "model": "gpt-5-nano",
            },
            task_label="generic_browser_task",
            system_prompt="You are a browser control agent.",
            user_prompt="Open the Easy Apply flow.",
            max_iterations=10,
            max_tokens=1000,
        )

        self.assertEqual(result["summary"], "Opened Easy Apply flow.")
        self.assertEqual(result["status"], "completed")
        self.assertEqual(result["finalUrl"], "https://www.linkedin.com/jobs/view/123")
        self.assertEqual(len(llm.prompts), 2)
        self.assertIn("Do not call tools.", llm.prompts[1])
        self.assertIn("Easy Apply dialog is visible", llm.prompts[1])


class DeriveBrowserWorkItemsTests(unittest.IsolatedAsyncioTestCase):
    async def test_derives_repeated_work_items_from_live_page_analysis(self):
        class DiscoveryRuntime(StubPythonBrowserRuntime):
            def __init__(self, llm: FakeLLM):
                super().__init__(
                    llm,
                    {
                        "pageUrl": "https://jobs.example.com/search?q=software+engineer",
                        "pageTitle": "Software Engineer Jobs",
                        "pageSnapshot": "A search results page with repeated job cards.",
                    },
                )
                self.focus_calls: list[str] = []
                self.wait_calls: list[tuple[int, int]] = []

            async def focus_or_open_page(self, page_url: str) -> dict[str, object]:
                self.focus_calls.append(page_url)
                return {"pageId": 7, "url": page_url, "selected": True}

            async def wait_for_page_ready(self, page_id: int, timeout_ms: int) -> None:
                self.wait_calls.append((page_id, timeout_ms))

        llm = FakeLLM(
            [
                '{"mode":"queue","summary":"Queued repeated job cards from the live page tree.","workItems":[{"title":"Backend Engineer","pageUrl":"https://jobs.example.com/1","itemContext":"Strong backend fit."},{"title":"Platform Engineer","pageUrl":"https://jobs.example.com/2","itemContext":"Platform-heavy role."}]}'
            ]
        )
        runtime = DiscoveryRuntime(llm)

        result = await runtime.derive_browser_work_items(
            {
                "goal": "Review the visible jobs and queue the strong matches",
                "pageUrl": "https://jobs.example.com/search?q=software+engineer",
                "providerConfig": {
                    "provider": "openai",
                    "apiKey": "test-key",
                    "model": "gpt-5-nano",
                },
                "systemPrompt": "Use the browser page tree, not brittle selectors.",
            }
        )

        self.assertEqual(result["mode"], "queue")
        self.assertEqual(
            result["summary"], "Queued repeated job cards from the live page tree."
        )
        self.assertEqual(len(result["workItems"]), 2)
        self.assertEqual(result["workItems"][0]["title"], "Backend Engineer")
        self.assertEqual(
            result["workItems"][1]["pageUrl"], "https://jobs.example.com/2"
        )
        self.assertEqual(
            runtime.focus_calls,
            ["https://jobs.example.com/search?q=software+engineer"],
        )
        self.assertEqual(runtime.wait_calls, [(7, 15000)])
        self.assertEqual(len(llm.prompts), 1)
        self.assertIn("Return JSON only", llm.prompts[0])
        self.assertIn("Review the visible jobs and queue the strong matches", llm.prompts[0])


class GenericBrowserWorkflowTests(unittest.IsolatedAsyncioTestCase):
    async def test_workflow_retries_with_augmented_resume_context(self):
        class WorkflowRuntime(PythonBrowserRuntime):
            def __init__(self, app: MCPApp):
                super().__init__(agent=SimpleNamespace(context=app.context), app=app)
                self.calls: list[dict[str, object]] = []

            async def execute_generic_browser_task_once(self, payload: dict[str, object]):
                self.calls.append(dict(payload))
                if len(self.calls) == 1:
                    raise RuntimeError("Transient navigation failure")
                return {
                    "summary": "Recovered and completed the browser task.",
                    "metadata": {
                        "kind": "execute_agent_task",
                        "status": "completed",
                        "executionMode": "iterative_orchestrator",
                        "finalUrl": "https://example.com/done",
                        "taskSteps": [
                            {
                                "title": "Inspect the current page",
                                "resultSummary": "Verified the current browser state.",
                            },
                            {
                                "title": "Complete the requested action",
                                "resultSummary": "Performed the action and verified success.",
                            },
                        ],
                    },
                }

            async def capture_selected_page_state(self) -> dict[str, object]:
                return {
                    "pageUrl": "https://example.com/retry",
                    "pageTitle": "Retry page",
                    "pageSnapshot": "The action button is still visible.",
                }

        app = MCPApp(name="python_browser_runtime_test")
        async with app.run():
            runtime = WorkflowRuntime(app)
            workflow_cls = runtime.create_generic_task_workflow_class()
            self.assertIsNotNone(workflow_cls)
            workflow = workflow_cls(context=app.context)

            result = await workflow.run(
                {
                    "goal": "Finish the browser task",
                    "providerConfig": {
                        "provider": "openai",
                        "apiKey": "test-key",
                        "model": "gpt-5-nano",
                    },
                    "resumeContext": "Previous run context",
                }
            )

        self.assertEqual(result.value["summary"], "Recovered and completed the browser task.")
        self.assertEqual(result.metadata["attempts"], 2)
        self.assertTrue(result.metadata["recovered"])
        self.assertEqual(len(runtime.calls), 2)
        self.assertIn("Retry attempt 1 after the browser task failed.", str(runtime.calls[1]["resumeContext"]))
        self.assertIn("Transient navigation failure", str(runtime.calls[1]["resumeContext"]))
        self.assertEqual(
            result.metadata["taskSteps"][1]["title"],
            "Complete the requested action",
        )

    async def test_can_start_workflow_and_query_status(self):
        class AsyncWorkflowRuntime(PythonBrowserRuntime):
            def __init__(self, app: MCPApp):
                super().__init__(agent=SimpleNamespace(context=app.context), app=app)
                self.calls = 0

            async def execute_generic_browser_task_once(self, payload: dict[str, object]):
                self.calls += 1
                await asyncio.sleep(0.01)
                return {
                    "summary": f"Completed: {payload['goal']}",
                    "metadata": {
                        "kind": "execute_agent_task",
                        "status": "completed",
                        "finalUrl": "https://example.com/final",
                        "taskSteps": [
                            {
                                "title": "Inspect the page",
                                "resultSummary": "Verified the page.",
                            }
                        ],
                    },
                }

        app = MCPApp(name="python_browser_runtime_async_test")
        async with app.run():
            runtime = AsyncWorkflowRuntime(app)
            started = await runtime.start_generic_browser_task_workflow(
                {
                    "goal": "Inspect the page",
                    "providerConfig": {
                        "provider": "openai",
                        "apiKey": "test-key",
                        "model": "gpt-5-nano",
                    },
                }
            )

            self.assertTrue(started["workflowId"])
            self.assertTrue(started["runId"])

            status = None
            for _ in range(10):
                status = await runtime.get_workflow_status(
                    workflow_id=started["workflowId"],
                    run_id=started["runId"],
                )
                if status and status.get("completed") is True:
                    break
                await asyncio.sleep(0.01)

        self.assertIsNotNone(status)
        self.assertEqual(status["status"], "completed")
        self.assertEqual(status["result"]["value"]["summary"], "Completed: Inspect the page")

    async def test_generic_queue_workflow_tracks_completed_and_skipped_items(self):
        class QueueWorkflowRuntime(PythonBrowserRuntime):
            def __init__(self, app: MCPApp):
                super().__init__(agent=SimpleNamespace(context=app.context), app=app)
                self.calls: list[dict[str, object]] = []

            async def execute_generic_browser_task_once(self, payload: dict[str, object]):
                self.calls.append(dict(payload))
                current_work_item = payload.get("currentWorkItem")
                target_name = (
                    str(current_work_item.get("targetName") or "").strip()
                    if isinstance(current_work_item, dict)
                    else ""
                )
                if target_name == "Jordan Recruiter":
                    return {
                        "summary": "Jordan was already handled earlier.",
                        "metadata": {
                            "kind": "execute_agent_task",
                            "status": "skipped",
                            "finalUrl": "https://example.com/targets/2",
                        },
                    }
                return {
                    "summary": "Completed the requested queued browser task.",
                    "metadata": {
                        "kind": "execute_agent_task",
                        "status": "completed",
                        "finalUrl": "https://example.com/targets/1",
                    },
                }

        app = MCPApp(name="python_browser_runtime_queue_test")
        async with app.run():
            runtime = QueueWorkflowRuntime(app)
            workflow_cls = runtime.create_generic_queue_workflow_class()
            self.assertIsNotNone(workflow_cls)
            workflow = workflow_cls(context=app.context)

            result = await workflow.run(
                {
                    "goal": "Open each recruiter page and perform the requested outreach task",
                    "providerConfig": {
                        "provider": "openai",
                        "apiKey": "test-key",
                        "model": "gpt-5-nano",
                    },
                    "workItems": [
                        {
                            "title": "Handle Taylor Recruiter",
                            "pageUrl": "https://example.com/targets/1",
                            "targetName": "Taylor Recruiter",
                            "itemContext": "Complete the requested outreach action on Taylor's page.",
                        },
                        {
                            "title": "Handle Jordan Recruiter",
                            "pageUrl": "https://example.com/targets/2",
                            "targetName": "Jordan Recruiter",
                            "itemContext": "Complete the requested outreach action on Jordan's page.",
                        },
                    ],
                }
            )

        self.assertEqual(len(runtime.calls), 2)
        self.assertEqual(
            result.value["summary"],
            "Queued browser workflow finished for 2 items. Completed: 1. Skipped: 1.",
        )
        self.assertEqual(result.metadata["workflowName"], "GenericBrowserQueueWorkflow")
        self.assertEqual(result.metadata["completed"], 1)
        self.assertEqual(result.metadata["skipped"], 1)
        self.assertEqual(result.metadata["failed"], 0)
        self.assertEqual(result.metadata["taskSteps"][0]["status"], "completed")
        self.assertEqual(result.metadata["taskSteps"][1]["status"], "skipped")
        self.assertEqual(
            result.metadata["taskSteps"][1]["skipReason"],
            "Jordan was already handled earlier.",
        )


class RetryResumeContextTests(unittest.TestCase):
    def test_builds_retry_resume_context_with_page_state(self):
        context = build_retry_resume_context(
            existing_resume_context="Previous context",
            attempt=2,
            error_message="Element not found",
            page_state={
                "pageUrl": "https://example.com/form",
                "pageTitle": "Example form",
                "pageSnapshot": "Submit button remains disabled.",
            },
        )

        self.assertIn("Previous context", context)
        self.assertIn("Retry attempt 2", context)
        self.assertIn("Element not found", context)
        self.assertIn("https://example.com/form", context)
        self.assertIn("Submit button remains disabled", context)


if __name__ == "__main__":
    unittest.main()
