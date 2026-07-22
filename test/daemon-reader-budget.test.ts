import { describe, it, expect } from "vitest";
import { PreAdmissionReaderBudget, ReaderBudgetExceededError } from "../src/daemon/server.js";

describe("PreAdmissionReaderBudget (C-092 P-026 xfam r2 B2)", () => {
  it("allows up to maxReaders concurrent acquisitions", () => {
    const budget = new PreAdmissionReaderBudget(2);
    budget.acquire();
    budget.acquire();
    expect(budget.activeCount).toBe(2);
  });

  it("throws ReaderBudgetExceededError once the ceiling is hit", () => {
    const budget = new PreAdmissionReaderBudget(1);
    budget.acquire();
    expect(() => budget.acquire()).toThrow(ReaderBudgetExceededError);
    expect(budget.activeCount).toBe(1); // rejected attempt never counted
  });

  it("frees a slot on release so a subsequent acquire succeeds", () => {
    const budget = new PreAdmissionReaderBudget(1);
    budget.acquire();
    budget.release();
    expect(budget.activeCount).toBe(0);
    expect(() => budget.acquire()).not.toThrow();
  });

  it("never goes negative on a spurious extra release", () => {
    const budget = new PreAdmissionReaderBudget(1);
    budget.release();
    budget.release();
    expect(budget.activeCount).toBe(0);
  });
});
