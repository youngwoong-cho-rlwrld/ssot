import assert from "node:assert/strict";
import test from "node:test";
import { MAX_CLUSTER_COUNT } from "../../../lib/clusters.ts";

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

test("deduplicates concurrent scans for the same cluster", async () => {
  const originalFetch = globalThis.fetch;
  let fetchCount = 0;
  let releaseFetch;
  const pendingFetch = new Promise((resolve) => {
    releaseFetch = resolve;
  });
  globalThis.fetch = () => {
    fetchCount += 1;
    return pendingFetch;
  };

  try {
    const { GET } = await importFreshRoute();
    const requestUrl = "http://viewer.test/api/results?cluster=dedupe-cluster";
    const first = GET(new Request(requestUrl));
    const second = GET(new Request(requestUrl));

    assert.equal(fetchCount, 1);
    releaseFetch(Response.json({ clusters: ["dedupe-cluster"], variants: [], errors: [] }));
    const responses = await Promise.all([first, second]);
    assert.deepEqual(responses.map((response) => response.status), [200, 200]);
    assert.equal(fetchCount, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("evicts the least-recently-used entry when the cache exceeds its bound", async () => {
  const originalFetch = globalThis.fetch;
  let fetchCount = 0;
  globalThis.fetch = async (url) => {
    fetchCount += 1;
    const cluster = new URL(String(url)).searchParams.get("cluster");
    return Response.json({ clusters: [cluster], variants: [], errors: [] });
  };

  try {
    const { GET } = await importFreshRoute();
    for (let index = 0; index <= MAX_CLUSTER_COUNT; index += 1) {
      const response = await GET(
        new Request(`http://viewer.test/api/results?cluster=cluster-${index}`),
      );
      assert.equal(response.status, 200);
    }
    assert.equal(fetchCount, MAX_CLUSTER_COUNT + 1);

    await GET(new Request("http://viewer.test/api/results?cluster=cluster-0"));
    assert.equal(fetchCount, MAX_CLUSTER_COUNT + 2);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
