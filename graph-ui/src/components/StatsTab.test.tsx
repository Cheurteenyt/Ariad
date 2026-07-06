// graph-ui/src/components/StatsTab.test.tsx
// R46 (F5): regression test for the R43 retry-in-error-branch fix (M5).
// The error branch must show a Retry button — pre-fix, the Refresh button only
// rendered in the success branch, so an initial-fetch failure was a dead-end.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, fireEvent } from "@testing-library/react";

vi.mock("../hooks/useProjects", () => ({
  useProjects: vi.fn(),
}));

import { StatsTab } from "./StatsTab";

describe("R43 (M5): StatsTab shows Retry in error branch", () => {
  beforeEach(() => vi.clearAllMocks());

  it("renders Retry button when useProjects returns an error", async () => {
    const { useProjects } = await import("../hooks/useProjects");
    const refresh = vi.fn();
    (useProjects as any).mockReturnValue({
      projects: [], loading: false, error: "Network error", refresh,
    });

    const { getByText, queryByText } = render(
      <StatsTab onSelectProject={vi.fn()} />,
    );

    expect(getByText("Network error")).toBeTruthy();
    expect(getByText("Retry")).toBeTruthy();
    // "Refresh" only renders in the success branch — must NOT be present here.
    expect(queryByText("Refresh")).toBeNull();

    fireEvent.click(getByText("Retry"));
    expect(refresh).toHaveBeenCalledTimes(1);
  });
});
