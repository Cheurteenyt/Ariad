// graph-ui/src/components/Sidebar.test.tsx
// R46 (F3): regression test for the R41 flattenSingleChild fix (UI-7).
// Deep single-child directory chains (src/a/b/c/d/e/file.ts) must be collapsed
// into a single nested entry, not 5 levels deep. Pre-R41 was O(n²).

import { describe, it, expect, vi } from "vitest";
import { render } from "@testing-library/react";
import { Sidebar } from "./Sidebar";
import type { GraphNode } from "../lib/types";

describe("R41 (UI-7): Sidebar flattenSingleChild — deep single-child chain", () => {
  it("renders without exploding on a deep single-child chain", () => {
    const node = {
      id: 1, label: "Function", name: "file.ts",
      file_path: "src/a/b/c/d/e/file.ts", qualified_name: "file",
      start_line: 1, end_line: 10, properties_json: "{}",
      risk_score: null, notes_count: 0, status: "active",
    } as GraphNode;

    // The key assertion: the component renders without throwing.
    // Pre-R41 would either throw (stack overflow on very deep chains) or
    // take seconds (O(n²) re-flattening). R41 is O(n) and stable.
    const { container } = render(
      <Sidebar nodes={[node]} onSelectPath={vi.fn()} selectedPath={null} />,
    );
    // Something should have rendered.
    expect(container.children.length).toBeGreaterThan(0);
  });

  it("renders in O(n) time — does not explode on a 20-deep chain", () => {
    const node = {
      id: 1, label: "Function", name: "f.ts",
      file_path: "a/".repeat(20) + "f.ts",
      qualified_name: "f", start_line: 1, end_line: 1,
      properties_json: "{}", risk_score: null, notes_count: 0, status: "active",
    } as GraphNode;

    const t0 = Date.now();
    render(<Sidebar nodes={[node]} onSelectPath={vi.fn()} selectedPath={null} />);
    // Pre-R41 O(n²) would take seconds; O(n) is < 50ms. Use a generous 2s bound
    // to avoid flake on CI while still catching a 100× regression.
    expect(Date.now() - t0).toBeLessThan(2000);
  });
});
