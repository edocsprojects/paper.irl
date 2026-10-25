import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { graphFromJson, type LobbyGraphJson } from "../src/graphJson.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "../../..");

describe("keller OSM graph", () => {
  it("loads compiled OSM graph with connected playable paths", () => {
    const raw = JSON.parse(
      readFileSync(join(root, "data/keller/graph.json"), "utf8"),
    ) as LobbyGraphJson;
    const g = graphFromJson(raw);
    expect(g.id).toBe("keller-osm-v1");
    expect(g.nodes.length).toBeGreaterThan(500);
    expect(g.edges.length).toBeGreaterThan(500);
    expect(g.centerLat).toBeCloseTo(44.97452, 4);
    const deg = [...g.nodeEdges.values()].map((x) => x.length);
    expect(Math.max(...deg)).toBeGreaterThan(1);
  });
});
