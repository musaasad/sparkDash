import { describe, expect, it, vi } from "vitest";
import { act } from "react";
import { Breadcrumb } from "./Breadcrumb";
import { PageHeader } from "./PageHeader";
import { render, cleanupRenders } from "../../testing/render";

describe("Breadcrumb", () => {
  it("renders '/' separators, link ancestors and a textPrimary current segment", () => {
    cleanupRenders();
    const navigate = vi.fn();
    const { container } = render(
      <Breadcrumb
        items={[{ label: "Lab", route: { section: "overview" } }, { label: "Models" }]}
        navigate={navigate}
      />
    );
    expect(container.querySelectorAll(".cp-crumb-sep")).toHaveLength(1);
    expect(container.querySelector(".cp-crumb-current")?.textContent).toBe("Models");
    expect(container.querySelector(".cp-crumb-current")?.getAttribute("aria-current")).toBe("page");
    const link = container.querySelector(".cp-crumb button") as HTMLButtonElement;
    act(() => link.click());
    expect(navigate).toHaveBeenCalledWith({ section: "overview" });
  });
});

describe("PageHeader", () => {
  it("renders the H1, subtitle and a capped action cluster", () => {
    cleanupRenders();
    const { container } = render(
      <PageHeader title="Fleet" subtitle="Compute nodes with live status." actions={<button>New</button>} />
    );
    expect(container.querySelector("h1.cp-page-h1")?.textContent).toBe("Fleet");
    expect(container.querySelector(".cp-page-sub")?.textContent).toContain("Compute nodes");
    expect(container.querySelector(".cp-page-actions button")?.textContent).toBe("New");
  });

  it("omits the action cluster when there are no actions", () => {
    cleanupRenders();
    const { container } = render(<PageHeader title="Overview" />);
    expect(container.querySelector(".cp-page-actions")).toBeNull();
  });
});
