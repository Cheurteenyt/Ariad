// graph-ui/src/components/ControlTab.test.tsx
// R46 (F4): regression test for the R43 kill-confirmation gate (M3).
// A misclick on the small Kill button must NOT terminate a long-running index
// job without consent. window.confirm must be called first.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, waitFor, fireEvent } from "@testing-library/react";

vi.mock("../api/client", () => ({
  api: {
    getProcesses: vi.fn().mockResolvedValue({ processes: [] }),
    getLogs: vi.fn().mockResolvedValue({ lines: [] }),
    getIndexStatus: vi.fn().mockResolvedValue({ jobs: [] }),
    killProcess: vi.fn().mockResolvedValue({ ok: true }),
  },
}));

import { ControlTab } from "./ControlTab";

describe("R43 (M3): ControlTab kill confirmation gate", () => {
  beforeEach(() => vi.clearAllMocks());

  it("does NOT call killProcess when window.confirm is dismissed", async () => {
    const { api } = await import("../api/client");
    (api.getProcesses as any).mockResolvedValue({
      processes: [
        { pid: 1234, cpu: 1.2, rss_mb: 100, elapsed: "1m", command: "node", is_self: false },
      ],
    });
    vi.spyOn(window, "confirm").mockReturnValue(false);

    const { findByText } = render(<ControlTab />);
    const killBtn = await findByText("Kill");
    fireEvent.click(killBtn);

    expect(window.confirm).toHaveBeenCalledWith(expect.stringContaining("Kill process 1234"));
    expect(api.killProcess).not.toHaveBeenCalled();
  });

  it("calls killProcess when window.confirm is accepted", async () => {
    const { api } = await import("../api/client");
    (api.getProcesses as any).mockResolvedValue({
      processes: [
        { pid: 4321, cpu: 1.2, rss_mb: 100, elapsed: "1m", command: "node", is_self: false },
      ],
    });
    vi.spyOn(window, "confirm").mockReturnValue(true);

    const { findByText } = render(<ControlTab />);
    fireEvent.click(await findByText("Kill"));

    await waitFor(() => expect(api.killProcess).toHaveBeenCalledWith(4321));
  });
});
