import assert from "node:assert/strict";
import test from "node:test";
let moduleSequence = 0;

function importFreshRoute() {
  moduleSequence += 1;
  return import(`./route.ts?test=${moduleSequence}`);
}

test("requires exactly one cluster query parameter", async () => {
  const originalFetch = globalThis.fetch;
  let fetchCount = 0;
  globalThis.fetch = async () => {
    fetchCount += 1;
    throw new Error("validation must happen before fetch");
  };

  try {
    const { GET } = await importFreshRoute();
    const missing = await GET(new Request("http://viewer.test/api/results"));
    const repeated = await GET(
      new Request("http://viewer.test/api/results?cluster=one&cluster=two"),
    );

    assert.equal(missing.status, 400);
    assert.match((await missing.json()).error, /required/);
    assert.equal(repeated.status, 400);
    assert.match((await repeated.json()).error, /only once/);
    assert.equal(fetchCount, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("rejects invalid clusters before contacting upstream", async () => {
  const originalFetch = globalThis.fetch;
  let fetchCount = 0;
  globalThis.fetch = async () => {
    fetchCount += 1;
    throw new Error("validation must happen before fetch");
  };

  try {
    const { GET } = await importFreshRoute();
    const response = await GET(
      new Request("http://viewer.test/api/results?cluster=invalid%2Fcluster"),
    );

    assert.equal(response.status, 400);
    assert.equal(fetchCount, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("forwards one cluster and returns the upstream payload unchanged", async () => {
  const originalFetch = globalThis.fetch;
  const requestedUrls = [];
  const payload = {
    clusters: ["cluster-one"],
    variants: [{ cluster: "cluster-one", variant: "experiment", tasks: [] }],
    errors: [],
  };
  globalThis.fetch = async (url) => {
    requestedUrls.push(String(url));
    return Response.json(payload);
  };

  try {
    const { GET } = await importFreshRoute();
    const response = await GET(
      new Request("http://viewer.test/api/results?cluster=cluster-one"),
    );

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), payload);
    assert.equal(requestedUrls.length, 1);
    const upstream = new URL(requestedUrls[0]);
    assert.equal(upstream.pathname, "/api/results");
    assert.equal(upstream.searchParams.get("cluster"), "cluster-one");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("forwards fresh=1 to train-eval", async () => {
  const originalFetch = globalThis.fetch;
  let requestedUrl = "";
  globalThis.fetch = async (url) => {
    requestedUrl = String(url);
    return Response.json({
      clusters: ["fresh-cluster"],
      variants: [],
      errors: [],
      fetched_at: { "fresh-cluster": 123 },
      stale: false,
    });
  };

  try {
    const { GET } = await importFreshRoute();
    const response = await GET(
      new Request("http://viewer.test/api/results?cluster=fresh-cluster&fresh=1"),
    );
    assert.equal(response.status, 200);
    assert.equal(new URL(requestedUrl).searchParams.get("fresh"), "1");
    assert.deepEqual(await response.json(), {
      clusters: ["fresh-cluster"],
      variants: [],
      errors: [],
      fetched_at: { "fresh-cluster": 123 },
      stale: false,
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});
