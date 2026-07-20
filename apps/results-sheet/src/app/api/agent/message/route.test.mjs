import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
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

async function withContextDirectory(run) {
  const directory = await mkdtemp(path.join(tmpdir(), "results-agent-route-"));
  const original = process.env.RESULTS_AGENT_CONTEXT_DIR;
  process.env.RESULTS_AGENT_CONTEXT_DIR = directory;
  try {
    return await run(directory);
  } finally {
    if (original === undefined) delete process.env.RESULTS_AGENT_CONTEXT_DIR;
    else process.env.RESULTS_AGENT_CONTEXT_DIR = original;
    await rm(directory, { recursive: true, force: true });
  }
}

test("sends the Results context to OpenClaw with the selected model", async () => {
  const originalFetch = globalThis.fetch;
  let upstreamUrl = "";
  let upstreamBody = null;
  let requestContext = null;
  globalThis.fetch = async (url, init) => {
    upstreamUrl = String(url);
    upstreamBody = JSON.parse(String(init?.body));
    const contextFile = /^Request context file: (.+)$/m.exec(upstreamBody.message)?.[1];
    assert.ok(contextFile);
    requestContext = JSON.parse(await readFile(contextFile, "utf8"));
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
    await withContextDirectory(async (directory) => {
      const { POST } = await importFreshRoute();
      const response = await POST(new Request("http://viewer.test/api/agent/message", {
        method: "POST",
        headers: AUTH_HEADERS,
        body: JSON.stringify({
          message: "Sort by experiment",
          context: { columns: [{ id: "experiment" }], rowIdsInCurrentOrder: [] },
          model: "anthropic/claude-test",
          sessionKey: SESSION_KEY,
        }),
      }));

      assert.equal(response.status, 200);
      assert.equal(new URL(upstreamUrl).pathname, "/api/chat");
      assert.equal(upstreamBody.model, "anthropic/claude-test");
      assert.equal(upstreamBody.session_key, SESSION_KEY);
      assert.match(upstreamBody.message, /Sort by experiment/);
      assert.match(upstreamBody.message, /Request context file:/);
      assert.doesNotMatch(upstreamBody.message, /"columns":/);
      assert.deepEqual(requestContext.context, {
        columns: [{ id: "experiment" }],
        rowIdsInCurrentOrder: [],
      });
      assert.deepEqual(await response.json(), {
        message: "Sorted the table.",
        actions: [{ type: "setSort", items: [{ fieldId: "experiment", sortState: "asc" }] }],
        sessionKey: SESSION_KEY,
      });
      assert.deepEqual(await readdir(directory), []);
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
    await withContextDirectory(async () => {
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
        sessionKey: SESSION_KEY,
      });
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("recovers a transcript compaction failure with a fresh session", async () => {
  const originalFetch = globalThis.fetch;
  const upstreamBodies = [];
  globalThis.fetch = async (_url, init) => {
    upstreamBodies.push(JSON.parse(String(init?.body)));
    if (upstreamBodies.length === 1) {
      return Response.json(
        { detail: "openclaw agent exited 1: CLI transcript compaction failed" },
        { status: 502 },
      );
    }
    return Response.json({
      result: { meta: { finalAssistantVisibleText: "Recovered." } },
    });
  };

  try {
    await withContextDirectory(async () => {
      const { POST } = await importFreshRoute();
      const response = await POST(new Request("http://viewer.test/api/agent/message", {
        method: "POST",
        headers: AUTH_HEADERS,
        body: JSON.stringify({
          message: "Show poc1",
          context: {},
          model: "openai/gpt-test",
          sessionKey: SESSION_KEY,
        }),
      }));
      const payload = await response.json();

      assert.equal(response.status, 200);
      assert.equal(upstreamBodies.length, 2);
      assert.equal(upstreamBodies[0].session_key, SESSION_KEY);
      assert.match(upstreamBodies[1].session_key, /^agent:main:ssot-results-/);
      assert.notEqual(upstreamBodies[1].session_key, SESSION_KEY);
      assert.equal(payload.sessionKey, upstreamBodies[1].session_key);
      assert.equal(payload.message, "Recovered.");
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
