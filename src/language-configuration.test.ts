import { describe, expect, it } from "vitest";
import configuration from "../language-configuration.json";

const increaseIndent = new RegExp(configuration.indentationRules.increaseIndentPattern);
const decreaseIndent = new RegExp(configuration.indentationRules.decreaseIndentPattern);

describe("increaseIndentPattern", () => {
  const increases = [
    "func take_damage(amount: int) -> void:",
    "class Inner:",
    "trait Damageable:",
    "if health <= 0:",
    "elif health < 10:",
    "else:",
    "for enemy in enemies:",
    "while running:",
    "match state:",
    "        nested_if_deeply_indented:",
    "extend int uses Describable:",
    "func f():  # trailing comment",
  ];

  for (const line of increases) {
    it(`increases indent after: ${line.trim()}`, () => {
      expect(increaseIndent.test(line)).toBe(true);
    });
  }

  const doesNotIncrease = [
    "var mapping = { \"a\": 1 }",
    "var health: int = 100",
    "# a comment ending in a colon:",
    "return",
  ];

  for (const line of doesNotIncrease) {
    it(`does not increase indent after: ${line.trim()}`, () => {
      expect(increaseIndent.test(line)).toBe(false);
    });
  }
});

describe("decreaseIndentPattern", () => {
  it("decreases indent on else", () => {
    expect(decreaseIndent.test("    else:")).toBe(true);
  });

  it("decreases indent on elif", () => {
    expect(decreaseIndent.test("    elif ready:")).toBe(true);
  });

  it("does not decrease indent on an ordinary statement", () => {
    expect(decreaseIndent.test("    health -= 1")).toBe(false);
  });
});
