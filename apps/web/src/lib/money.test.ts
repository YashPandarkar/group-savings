import { describe, expect, it } from "vitest";
import { bpsToPercent, formatPaise, paiseToInput, parseDecimalToInt, percentToBps, rupeesToPaise } from "./money";

describe("rupeesToPaise", () => {
  it("converts with string math, so floating-point traps can't happen", () => {
    expect(rupeesToPaise("200")).toBe(20000);
    expect(rupeesToPaise("200.5")).toBe(20050);
    expect(rupeesToPaise("1,000.25")).toBe(100025);
    expect(rupeesToPaise(" 15 ")).toBe(1500);
    expect(rupeesToPaise("0.07")).toBe(7);
    // As floats, 19.99 * 100 and 1.15 * 100 are 1998.9999999999998 and 114.99999999999999.
    expect(rupeesToPaise("19.99")).toBe(1999);
    expect(rupeesToPaise("1.15")).toBe(115);
  });

  it("refuses anything that isn't a plain non-negative amount with at most 2 decimals", () => {
    for (const bad of ["", "abc", "-5", ".5", "5.", "1.234", "1e3", "1 000", "₹5", "5,0,0.0.0"]) {
      expect(rupeesToPaise(bad), bad).toBeNull();
    }
  });

  it("refuses amounts too large to be exact", () => {
    expect(rupeesToPaise("9999999999999999")).toBeNull();
  });
});

describe("other converters", () => {
  it("handles whole numbers and percentages", () => {
    expect(parseDecimalToInt("12", 0)).toBe(12);
    expect(parseDecimalToInt("007", 0)).toBe(7);
    expect(parseDecimalToInt("12.5", 0)).toBeNull();
    expect(percentToBps("12")).toBe(1200);
    expect(percentToBps("12.5")).toBe(1250);
    expect(bpsToPercent(1200)).toBe("12");
    expect(bpsToPercent(1250)).toBe("12.50");
    expect(paiseToInput(20000)).toBe("200");
    expect(paiseToInput(20050)).toBe("200.50");
  });
});

describe("formatPaise", () => {
  it("shows rupees with Indian digit grouping", () => {
    expect(formatPaise(20000)).toBe("₹200.00");
    expect(formatPaise(0)).toBe("₹0.00");
    expect(formatPaise(5)).toBe("₹0.05");
    expect(formatPaise(100000)).toBe("₹1,000.00");
    expect(formatPaise(10000000)).toBe("₹1,00,000.00");
    expect(formatPaise(123456789)).toBe("₹12,34,567.89");
    expect(formatPaise(-5)).toBe("-₹0.05");
  });
});
