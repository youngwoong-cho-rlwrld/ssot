import assert from "node:assert/strict";
import test from "node:test";

test("forwards the exact gateway user to train-eval cluster discovery", async () => {
  const originalFetch = globalThis.fetch;
  let upstreamHeaders;
  globalThis.fetch = async (_url, init) => {
    upstreamHeaders = new Headers(init?.headers);
    return Response.json({ clusters: ["kakao"] });
  };
  try {
    const { GET } = await import("./route.ts?identity-test=1");
    const response = await GET(
      new Request("http://viewer.test/api/clusters", {
        headers: { "x-ssot-user": "person@example.com" },
      }),
    );
    assert.equal(response.status, 200);
    assert.equal(upstreamHeaders.get("x-ssot-user"), "person@example.com");
    assert.deepEqual(await response.json(), { clusters: ["kakao"] });
  } finally {
    globalThis.fetch = originalFetch;
  }
});
