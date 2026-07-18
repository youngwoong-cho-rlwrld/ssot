import assert from "node:assert/strict";
import test from "node:test";

import {
  decodeViewState,
  encodeViewState,
  reconcileViewStateColumns,
  VIEW_STATE_LIMITS,
} from "./viewState.ts";

function condition(id, columnId = "experiment") {
  return {
    id,
    columnId,
    operator: "CONTAINS",
    value: `value-${id}`,
    source: "advanced-filter",
  };
}

function filterState(filterSet = []) {
  return {
    filters: { conjunction: "and", filterSet },
    source: "advanced-filter",
  };
}

function colorRule(id) {
  return {
    id,
    color: "#D7EBE4",
    targetType: "row",
    filter: filterState([condition(`${id}-condition`)]),
  };
}

function viewState(overrides = {}) {
  return {
    sort: [],
    filters: filterState(),
    colors: [],
    visibleColumnIds: null,
    chartOpen: false,
    chartType: "bar",
    chartGroupBy: "auto",
    chartGroupOverrides: {},
    chatOpen: false,
    ...overrides,
  };
}

test("round-trips valid, bounded view state", () => {
  const nested = {
    id: "nested-1",
    type: "nested",
    conjunction: "or",
    filterSet: [condition("condition-2", "variant")],
    source: "search",
  };
  const sort = [
    { id: "sort-1", fieldId: "totalAverage", sortState: "desc" },
  ];
  const filters = filterState([condition("condition-1"), nested]);
  const colors = [colorRule("color-1")];
  const state = viewState({
    sort,
    filters,
    colors,
    visibleColumnIds: ["experiment", "pick_bucket::0cm"],
    chartOpen: true,
    chartType: "radar",
    chartGroupBy: "experiment",
    chartGroupOverrides: { pick_bucket: "evalSet" },
    chatOpen: true,
  });

  assert.deepEqual(decodeViewState(encodeViewState(state)), state);
});

test("encodes chart grouping only when it differs from the auto default", () => {
  const defaultQuery = encodeViewState(viewState());
  const defaultParams = new URLSearchParams(defaultQuery);
  assert.equal(defaultParams.get("chartGroupBy"), null);
  assert.equal(defaultParams.get("chartGroups"), null);

  const query = encodeViewState(viewState({
    chartGroupBy: "evalSet",
    chartGroupOverrides: { water_plant: "experiment" },
  }));
  const decoded = decodeViewState(query);
  assert.equal(decoded.chartGroupBy, "evalSet");
  assert.deepEqual(decoded.chartGroupOverrides, { water_plant: "experiment" });
});

test("encodes chart visibility independently from the selected chart type", () => {
  const closedQuery = encodeViewState(viewState({ chartOpen: false, chartType: "heatmap" }));
  const closedParams = new URLSearchParams(closedQuery);
  assert.equal(closedParams.get("chart"), null);
  assert.equal(closedParams.get("chartType"), "heatmap");
  assert.deepEqual(decodeViewState(closedQuery), { chartType: "heatmap" });

  const openQuery = encodeViewState(viewState({ chartOpen: true, chartType: "bar" }));
  const openParams = new URLSearchParams(openQuery);
  assert.equal(openParams.get("chart"), "1");
  assert.equal(openParams.get("chartType"), null);
  assert.deepEqual(decodeViewState(openQuery), { chartOpen: true });
});

test("does not expose malformed array entries", () => {
  const params = new URLSearchParams();
  params.set("sort", JSON.stringify([null]));
  params.set("filters", JSON.stringify({ filters: { conjunction: "and", filterSet: [null] } }));
  params.set("colors", JSON.stringify([null]));
  params.set("chart", "radar");
  params.set("chartType", "pie");
  params.set("chartGroupBy", "pie");
  params.set("chartGroups", JSON.stringify({ water_plant: "weird", "bad id": "evalSet" }));
  params.set("chat", "true");

  assert.deepEqual(decodeViewState(params.toString()), {});
});

test("keeps valid entries, rejects invalid fields, and deduplicates IDs", () => {
  const params = new URLSearchParams();
  params.set("sort", JSON.stringify([
    null,
    { id: "sort-1", fieldId: "experiment", sortState: "asc" },
    { id: "sort-1", fieldId: "variant", sortState: "desc" },
    { id: "sort-2", fieldId: "completed", sortState: "sideways" },
  ]));
  params.set("filters", JSON.stringify({
    source: "not-a-source",
    filters: {
      conjunction: "invalid",
      filterSet: [
        null,
        { id: "bad", columnId: "experiment", operator: "EXECUTE", value: "x" },
        condition("good"),
      ],
    },
  }));
  params.set("colors", JSON.stringify([
    null,
    { ...colorRule("color-1"), targetType: "page" },
    colorRule("color-2"),
  ]));
  params.set("cols", [
    " experiment ",
    "",
    "experiment",
    "bad id",
    "bad\u0000id",
    "pick::0cm",
  ].join(","));
  params.set("chart", "1");
  params.set("chartType", "line");
  params.set("chat", "1");

  const decoded = decodeViewState(params.toString());
  assert.deepEqual(decoded.sort, [
    { id: "sort-1", fieldId: "experiment", sortState: "asc" },
  ]);
  assert.deepEqual(decoded.filters, {
    filters: { conjunction: "and", filterSet: [condition("good")] },
  });
  assert.deepEqual(decoded.colors, [colorRule("color-2")]);
  assert.deepEqual(decoded.visibleColumnIds, ["experiment", "pick::0cm"]);
  assert.equal(decoded.chartOpen, true);
  assert.equal(decoded.chartType, "line");
  assert.equal(decoded.chatOpen, true);
});

test("caps every repeated URL field", () => {
  const params = new URLSearchParams();
  params.set("sort", JSON.stringify(
    Array.from({ length: VIEW_STATE_LIMITS.sortItems + 10 }, (_, index) => ({
      id: `sort-${index}`,
      fieldId: `field-${index}`,
      sortState: index % 2 ? "asc" : "desc",
    })),
  ));
  params.set("filters", JSON.stringify(filterState(
    Array.from({ length: VIEW_STATE_LIMITS.filterNodes + 10 }, (_, index) => condition(`filter-${index}`)),
  )));
  params.set("colors", JSON.stringify(
    Array.from({ length: VIEW_STATE_LIMITS.colorItems + 10 }, (_, index) => colorRule(`color-${index}`)),
  ));
  params.set("cols", Array.from(
    { length: VIEW_STATE_LIMITS.visibleColumns + 10 },
    (_, index) => `column-${index}`,
  ).join(","));
  params.set("chartGroups", JSON.stringify(Object.fromEntries(Array.from(
    { length: VIEW_STATE_LIMITS.chartGroupOverrides + 10 },
    (_, index) => [`task-${index}`, "experiment"],
  ))));

  const decoded = decodeViewState(params.toString());
  assert.equal(decoded.sort?.length, VIEW_STATE_LIMITS.sortItems);
  assert.equal(decoded.filters?.filters.filterSet.length, VIEW_STATE_LIMITS.filterNodes);
  assert.equal(decoded.colors?.length, VIEW_STATE_LIMITS.colorItems);
  assert.equal(decoded.visibleColumnIds?.length, VIEW_STATE_LIMITS.visibleColumns);
  assert.equal(
    Object.keys(decoded.chartGroupOverrides ?? {}).length,
    VIEW_STATE_LIMITS.chartGroupOverrides,
  );
});

test("rejects over-deep filters, oversized values, and oversized parameters", () => {
  let node = condition("deep-condition");
  for (let depth = 0; depth <= VIEW_STATE_LIMITS.filterDepth; depth += 1) {
    node = {
      id: `nested-${depth}`,
      type: "nested",
      conjunction: "and",
      filterSet: [node],
    };
  }

  const params = new URLSearchParams();
  params.set("filters", JSON.stringify(filterState([node])));
  assert.deepEqual(decodeViewState(params.toString()), {});

  params.set("filters", JSON.stringify(filterState([{
    ...condition("too-long"),
    value: "x".repeat(VIEW_STATE_LIMITS.stringLength + 1),
  }])));
  assert.deepEqual(decodeViewState(params.toString()), {});

  params.set("sort", "x".repeat(VIEW_STATE_LIMITS.parameterLength + 1));
  assert.deepEqual(decodeViewState(params.toString()), {});
});

test("normalizes an empty visible-column set to the all-columns default", () => {
  const query = encodeViewState(viewState({ visibleColumnIds: [] }));
  assert.equal(new URLSearchParams(query).has("cols"), false);
  const invalidQuery = encodeViewState(viewState({ visibleColumnIds: [" ", "bad id"] }));
  assert.equal(new URLSearchParams(invalidQuery).has("cols"), false);
  assert.deepEqual(decodeViewState(query), {});
  assert.deepEqual(decodeViewState("cols="), {});
  assert.deepEqual(decodeViewState("cols=,%20,bad%20id"), {});
});

test("reconciles every column-bearing view-state branch against current headers", () => {
  const state = viewState({
    sort: [
      { id: "sort-valid", fieldId: "experiment", sortState: "asc" },
      { id: "sort-unknown", fieldId: "unknown", sortState: "desc" },
    ],
    filters: filterState([
      condition("filter-valid", "experiment"),
      condition("filter-unknown", "unknown"),
      { ...condition("filter-wrong-operator", "experiment"), operator: "GT", value: 5 },
    ]),
    colors: [
      colorRule("color-valid"),
      {
        ...colorRule("color-unknown"),
        filter: filterState([condition("bad-color-filter", "unknown")]),
      },
    ],
    visibleColumnIds: ["unknown"],
    chartGroupOverrides: { pick_bucket: "experiment", unknown_task: "evalSet" },
  });

  const reconciled = reconcileViewStateColumns(state, [
    { id: "experiment", displayName: "Experiments", type: "TEXT" },
    { id: "variant", displayName: "Jobs", type: "TEXT" },
    { id: "pick_bucket::rand_obj", displayName: "Pick Bucket rand_obj", type: "TEXT" },
  ]);
  assert.deepEqual(reconciled.sort.map(({ id }) => id), ["sort-valid"]);
  assert.deepEqual(reconciled.filters.filters.filterSet.map(({ id }) => id), ["filter-valid"]);
  assert.deepEqual(reconciled.colors.map(({ id }) => id), ["color-valid"]);
  assert.equal(reconciled.visibleColumnIds, null);
  assert.deepEqual(reconciled.chartGroupOverrides, { pick_bucket: "experiment" });
});
