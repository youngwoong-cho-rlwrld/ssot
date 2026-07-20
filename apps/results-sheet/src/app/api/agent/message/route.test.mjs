import assert from "node:assert/strict";
import test from "node:test";

let moduleSequence = 0;
const SESSION_KEY = "agent:main:ssot-results-123e4567-e89b-42d3-a456-426614174000";
const AUTH_HEADERS = {
  "Content-Type": "application/json",
  "x-ssot-user": "owner@example.com",
};

function importFreshRoute() {
  moduleSequence += 1;
  return import(`./route.ts?test=${moduleSequence}`);
}

test("sends the Results context to OpenClaw with the selected model", async () => {
  const originalFetch = globalThis.fetch;
  let upstreamUrl = "";
  let upstreamBody = null;
  globalThis.fetch = async (url, init) => {
    upstreamUrl = String(url);
    upstreamBody = JSON.parse(String(init?.body));
    return Response.json({
      result: {
        payloads: [{
          text: JSON.stringify({
            message: "Sorted the table.",
            actions: [{ type: "setSort", items: [{ fieldId: "experiment", sortState: "asc" }] }],
          }),
        }],
      },
    });
  };

  try {
    const { POST } = await importFreshRoute();
    const response = await POST(new Request("http://viewer.test/api/agent/message", {
      method: "POST",
      headers: AUTH_HEADERS,
      body: JSON.stringify({
        message: "Sort by experiment",
        context: { columns: [{ id: "experiment" }], rowsInCurrentOrder: [] },
        model: "anthropic/claude-test",
        sessionKey: SESSION_KEY,
      }),
    }));

    assert.equal(response.status, 200);
    assert.equal(new URL(upstreamUrl).pathname, "/api/chat");
    assert.equal(upstreamBody.model, "anthropic/claude-test");
    assert.equal(upstreamBody.session_key, SESSION_KEY);
    assert.match(upstreamBody.message, /Sort by experiment/);
    assert.match(upstreamBody.message, /rowsInCurrentOrder/);
    assert.deepEqual(await response.json(), {
      message: "Sorted the table.",
      actions: [{ type: "setSort", items: [{ fieldId: "experiment", sortState: "asc" }] }],
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("turns a plain OpenClaw reply into a safe message-only envelope", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => Response.json({
    result: { meta: { finalAssistantVisibleText: "There are three matching experiments." } },
  });

  try {
    const { POST } = await importFreshRoute();
    const response = await POST(new Request("http://viewer.test/api/agent/message", {
      method: "POST",
      headers: AUTH_HEADERS,
      body: JSON.stringify({
        message: "How many match?",
        context: {},
        model: "anthropic/claude-test",
        sessionKey: SESSION_KEY,
      }),
    }));

    assert.deepEqual(await response.json(), {
      message: "There are three matching experiments.",
      actions: [],
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("rejects an invalid session key before contacting OpenClaw", async () => {
  const originalFetch = globalThis.fetch;
  let fetchCount = 0;
  globalThis.fetch = async () => {
    fetchCount += 1;
    throw new Error("must not fetch");
  };

  try {
    const { POST } = await importFreshRoute();
    const response = await POST(new Request("http://viewer.test/api/agent/message", {
      method: "POST",
      headers: AUTH_HEADERS,
      body: JSON.stringify({ message: "hello", context: {}, sessionKey: "invalid" }),
    }));
    assert.equal(response.status, 400);
    assert.equal(fetchCount, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("requires a trusted SSOT user before contacting OpenClaw", async () => {
  const originalFetch = globalThis.fetch;
  let fetchCount = 0;
  globalThis.fetch = async () => {
    fetchCount += 1;
    throw new Error("must not fetch");
  };

  try {
    const { POST } = await importFreshRoute();
    const response = await POST(new Request("http://viewer.test/api/agent/message", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "hello", context: {}, sessionKey: SESSION_KEY }),
    }));
    assert.equal(response.status, 401);
    assert.equal(fetchCount, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
