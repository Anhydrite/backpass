import test from "node:test";
import assert from "node:assert/strict";

import { resolvedEffort } from "../src/agents.js";
import { prepareHarnessInvocation } from "../src/harness-invoke.js";

const config = { analysis: { effort: null }, synthesis: { effort: null } };

test("maki resolves no effort overlay, like opencode", () => {
  assert.equal(resolvedEffort("analysis", "maki", config), null);
  assert.equal(resolvedEffort("synthesis", "maki", config), null);
  assert.equal(resolvedEffort("synthesis", "claude", config), "high", "other harnesses keep their default effort");
});

test("maki forwards a pinned model through acpx and writes no harness settings", () => {
  const invocation = prepareHarnessInvocation({ agent: "maki", model: "ocgo/deepseek-v4.1-flash" });
  try {
    assert.equal(invocation.acpxModel, "ocgo/deepseek-v4.1-flash");
    assert.equal(invocation.acpxAgentCommand, null);
    assert.equal(invocation.setEffortKey, null);
    assert.equal(invocation.requiredBuiltinAgent, null, "maki is an acpx custom agent, so no builtin probe");
    assert.equal(invocation.env, undefined);
  } finally {
    invocation.dispose();
  }
});

test("an effort pinned on maki is reported as not forwarded instead of failing", () => {
  const invocation = prepareHarnessInvocation({ agent: "maki", effort: "high" });
  try {
    assert.match(invocation.notes.join("\n"), /effort=high is not forwarded/);
  } finally {
    invocation.dispose();
  }
});
