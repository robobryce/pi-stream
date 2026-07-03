// Tests for shouldRetryRecoveredTurn: the swallowed-prompt recovery path drives
// the turn via sendUserMessage (bypassing Pi's print-mode retry loop), so it must
// retry empty + transient-error turns itself. Permanent errors must NOT retry.
import assert from "node:assert/strict";
import { test } from "node:test";
import { shouldRetryRecoveredTurn } from "../src/extension.ts";

test("retries empty recovered turns", () => {
  assert.equal(shouldRetryRecoveredTurn({ role: "assistant", content: [], stopReason: "stop", usage: { totalTokens: 0, output: 0 } }), true);
  assert.equal(shouldRetryRecoveredTurn({ role: "assistant", content: [{ type: "text", text: " " }], stopReason: "stop", usage: { totalTokens: 0 } }), true);
});

test("retries transient errors (429/5xx/rate-limit/connection)", () => {
  for (const err of ["429 status code (no body)", "503 Service Unavailable", "overloaded_error", "fetch failed", "socket hang up", "rate limit exceeded"]) {
    assert.equal(shouldRetryRecoveredTurn({ role: "assistant", content: [], stopReason: "error", errorMessage: err }), true, err);
  }
});

test("does NOT retry permanent errors", () => {
  for (const err of ["401 Unauthorized", "invalid api key", "insufficient_quota", "monthly usage limit reached", "400 invalid request"]) {
    assert.equal(shouldRetryRecoveredTurn({ role: "assistant", content: [], stopReason: "error", errorMessage: err }), false, err);
  }
});

test("does NOT retry a real successful turn", () => {
  assert.equal(shouldRetryRecoveredTurn({ role: "assistant", content: [{ type: "text", text: "done" }], stopReason: "stop", usage: { totalTokens: 5, output: 5 } }), false);
  assert.equal(shouldRetryRecoveredTurn({ role: "assistant", content: [{ type: "toolCall" }], stopReason: "toolUse", usage: { totalTokens: 9 } }), false);
});

test("handles missing/non-assistant", () => {
  assert.equal(shouldRetryRecoveredTurn(undefined), false);
  assert.equal(shouldRetryRecoveredTurn({ role: "user", content: [] }), false);
});
