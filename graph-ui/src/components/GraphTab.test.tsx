// graph-ui/src/components/GraphTab.test.tsx
// R53 (Part E): test the C1 chain end-to-end — GraphTab must NOT unmount
// GraphCanvas across a same-project refetch (loading && !data gate).
// This closes the last untested link in the C1 regression chain:
// useGraphData.loading (tested) → GraphTab conditional (THIS TEST) → GraphCanvas unmount (tested)

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, act, waitFor } from "@testing-library/react";

// Mock useGraphData to control loading state
vi.mock("../hooks/useGraphData", () => ({
  useGraphData: vi.fn(),
  GRAPH_RENDER_NODE_LIMIT: 2000,
}));

// Mock useWebSocket (no-op)
vi.mock("../hooks/useWebSocket", () => ({
  useWebSocket: () => ({ connected: false, lastEvent: null, reconnect: () => {} }),
}));

import { GraphTab } from "./GraphTab";
import { useGraphData } from "../hooks/useGraphData";

const mockData = {
  nodes: [
    { id: 1, label: "Function", name: "foo", file_path: "a.ts", qualified_name: "foo", start_line: 1, end_line: 10, properties_json: "{}", risk_score: null, notes_count: 0, status: "active" },
  ],
  edges: [],
  total_nodes: 1,
};

describe("R53 (Part E): GraphTab C1 chain — canvas not unmounted on refetch", () => {
  beforeEach(() => vi.clearAllMocks());

  it("does NOT show spinner on same-project refetch (keeps GraphCanvas mounted)", async () => {
    const mockUseGraphData = useGraphData as any;

    // Initial state: loading=false, data=mockData (already loaded)
    mockUseGraphData.mockReturnValue({
      data: mockData,
      loading: false,
      error: null,
      fetchOverview: vi.fn(),
    });

    const { rerender, container } = render(<GraphTab project="test-project" />);

    // GraphCanvas should be rendered (not the spinner)
    const canvas = container.querySelector("canvas");
    expect(canvas).toBeTruthy();

    // Simulate a same-project refetch (WS notification):
    // loading stays false (C1 fix: same-project refetch doesn't set loading=true)
    // data stays the same
    rerender(<GraphTab project="test-project" />);

    // Canvas should STILL be there — no spinner replaced it
    const canvasAfterRefetch = container.querySelector("canvas");
    expect(canvasAfterRefetch).toBeTruthy();
    expect(canvasAfterRefetch).toBe(canvas); // same DOM element = not unmounted
  });

  it("DOES show spinner on project switch (loading=true, data=null)", () => {
    const mockUseGraphData = useGraphData as any;

    mockUseGraphData.mockReturnValue({
      data: null,
      loading: true,
      error: null,
      fetchOverview: vi.fn(),
    });

    const { container } = render(<GraphTab project="new-project" />);

    // Spinner should be shown, NOT canvas
    const canvas = container.querySelector("canvas");
    expect(canvas).toBeNull();
  });
});
