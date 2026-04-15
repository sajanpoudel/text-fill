from __future__ import annotations

import sys
import unittest
from pathlib import Path

ROOT_DIR = Path(__file__).resolve().parents[2]
if str(ROOT_DIR) not in sys.path:
    sys.path.insert(0, str(ROOT_DIR))

from companion.python_browser_runtime import (
    PythonBrowserRuntime,
    extract_json_payload,
    is_linkedin_profile_connect_goal,
)


class FakeLLM:
    def __init__(self, responses: list[str]):
        self._responses = list(responses)
        self.prompts: list[str] = []

    async def generate_str(self, prompt, _params):
        self.prompts.append(prompt)
        if not self._responses:
            raise AssertionError("No fake LLM response queued")
        return self._responses.pop(0)


class StubPythonBrowserRuntime(PythonBrowserRuntime):
    def __init__(self, llm: FakeLLM, page_state: dict[str, object]):
        super().__init__(agent=object())
        self._llm = llm
        self._page_state = page_state

    async def attach_augmented_llm(self, provider_config, instruction):
        return self._llm, "openai", str(provider_config.get("model") or "gpt-5-nano")

    async def capture_selected_page_state(self) -> dict[str, object]:
        return dict(self._page_state)


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


class RunAgentJsonTaskTests(unittest.IsolatedAsyncioTestCase):
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


if __name__ == "__main__":
    unittest.main()
