import assert from "node:assert/strict";
import test from "node:test";

import {
  addSearchFilter,
  createEmptyFilters,
  finalizeEditedFilters,
  mergeFilterSources,
  rowMatchesFilters,
  separateFilters,
  valueMatchesFilter,
} from "../enmight/utils/tables/filters.ts";
import { createTableColorResolver } from "./tableColors.ts";

function condition(operator, value) {
  return { id: "filter-1", columnId: "value", operator, value };
}

test("matches text, number, boolean, and date operators consistently", () => {
  assert.equal(valueMatchesFilter("Alpha Beta", condition("CONTAINS", "beta")), true);
  assert.equal(valueMatchesFilter("42.5%", condition("GT", 40)), true);
  assert.equal(valueMatchesFilter(false, condition("IS_FALSE", null)), true);
  assert.equal(
    valueMatchesFilter("07/10/2026 12:30", condition("AFTER", new Date(2026, 6, 10, 12, 0))),
    true,
  );
  assert.equal(valueMatchesFilter("", condition("EXISTS", null)), false);
});

test("honors nested conjunctions with one canonical row evaluator", () => {
  const filters = {
    filters: {
      conjunction: "and",
      filterSet: [
        { id: "name", columnId: "name", operator: "CONTAINS", value: "cube" },
        {
          id: "score-group",
          type: "nested",
          conjunction: "or",
          filterSet: [
            { id: "high", columnId: "score", operator: "GTE", value: 90 },
            { id: "baseline", columnId: "kind", operator: "EQUALS", value: "baseline" },
          ],
        },
      ],
    },
  };

  assert.equal(rowMatchesFilters({ id: "1", name: "Cube Box", score: 92, kind: "run" }, filters), true);
  assert.equal(rowMatchesFilters({ id: "2", name: "Cube Box", score: 20, kind: "baseline" }, filters), true);
  assert.equal(rowMatchesFilters({ id: "3", name: "Cylinder", score: 99, kind: "run" }, filters), false);
});

test("merges search and advanced sources without duplicating search state", () => {
  const searched = addSearchFilter(createEmptyFilters(), "experiment", "alpha");
  const advanced = {
    filters: {
      conjunction: "and",
      filterSet: [{
        id: "advanced",
        columnId: "score",
        operator: "GTE",
        value: 50,
        source: "advanced-filter",
      }],
    },
  };
  const merged = mergeFilterSources(searched, advanced);
  assert.equal(merged.filters.filterSet.length, 2);
  assert.equal(rowMatchesFilters({ id: "1", experiment: "Alpha", score: 75 }, merged), true);
  assert.equal(rowMatchesFilters({ id: "2", experiment: "Alpha", score: 10 }, merged), false);
  assert.equal(rowMatchesFilters({ id: "3", experiment: "Beta", score: 75 }, merged), false);
});

test("popover shares one filter state with the search bar", () => {
  // User searches, then opens the popover: the draft is seeded from the full
  // applied state, so the search-added filter is present and editable there.
  const searched = addSearchFilter(createEmptyFilters(), "experiment", "alpha");
  const draft = {
    filters: {
      conjunction: "and",
      filterSet: [
        ...searched.filters.filterSet,
        { id: "advanced", columnId: "score", operator: "GTE", value: 50 },
      ],
    },
  };

  // Applying the popover commits the full draft without dropping the search lane.
  const applied = finalizeEditedFilters(draft);
  const { hasAdvancedFilter, searchFilters } = separateFilters(applied);
  assert.equal(searchFilters.length, 1, "search filter survives popover apply");
  assert.equal(searchFilters[0].source, "search", "search source preserved for pill display");
  assert.equal(hasAdvancedFilter, true, "popover-added filter is classified as advanced");
  assert.equal(rowMatchesFilters({ id: "1", experiment: "Alpha", score: 75 }, applied), true);
  assert.equal(rowMatchesFilters({ id: "2", experiment: "Alpha", score: 10 }, applied), false);

  // Removing only the advanced row in the popover must not clobber the search filter.
  const withoutAdvanced = finalizeEditedFilters({
    filters: { conjunction: "and", filterSet: searched.filters.filterSet },
  });
  const afterRemoval = separateFilters(withoutAdvanced);
  assert.equal(afterRemoval.searchFilters.length, 1);
  assert.equal(afterRemoval.hasAdvancedFilter, false);
});

test("resolves scoped color rules with cell precedence and no global cache", () => {
  const rowRule = {
    id: "row",
    color: "#FFF3A5",
    targetType: "row",
    filter: { filters: { conjunction: "and", filterSet: [condition("GTE", 50)] } },
  };
  const cellRule = {
    id: "cell",
    color: "#D7EBE4",
    targetType: "cell",
    filter: { filters: { conjunction: "and", filterSet: [condition("GTE", 90)] } },
  };
  const header = { id: "value", displayName: "Value", type: "NUMBER" };
  const resolver = createTableColorResolver([cellRule, rowRule]);

  assert.equal(resolver(header, { id: "high", value: 95 }), "#D7EBE4");
  assert.equal(resolver(header, { id: "medium", value: 60 }), "#FFF3A5");
  assert.equal(resolver(header, { id: "low", value: 10 }), undefined);
  assert.equal(createTableColorResolver([])(header, { id: "high", value: 95 }), undefined);
});
