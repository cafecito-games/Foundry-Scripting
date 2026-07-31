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
    // Match arms (GRAMMAR.md 6.1) - patterns are arbitrary expressions, which is
    // why increaseIndentPattern cannot be a keyword list.
    "    Idle:",
    "    1, 2, 3:",
    "    _:",
    "    [first, second]:",
    "    Message.Move(x, y) when x > 0:",
    // Property accessors and class-body enums (GRAMMAR.md 4.4). The whole-file
    // enum form is spelled `enum_name Direction:` (3.2) and is not covered here.
    "    get:",
    "    set(value):",
    "enum Direction:",
    // Multi-line lambda (GRAMMAR.md 5.5).
    "var handler = func(x: int) -> int:",
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
    "signal died(cause: String)",
    "var slice = items[1:2]",
    "var label = \"a:\"",
    "var choice = 1 if ready else 2",
    "var inline = func(x): return x * 2",
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

  // Must stay symmetric with increaseIndentPattern. If only the increase side
  // allowed trailing comments, this line would indent its body but never dedent
  // itself, leaving the block a level too deep.
  it("decreases indent on else with a trailing comment", () => {
    expect(decreaseIndent.test("    else:  # handle default")).toBe(true);
  });

  it("decreases indent on elif with a trailing comment", () => {
    expect(decreaseIndent.test("    elif ready:  # nearly dead")).toBe(true);
  });

  // The trailing colon is required on purpose: without it, a wrapped ternary
  // such as `    else b)` would wrongly dedent.
  it("does not decrease indent before the colon is typed", () => {
    expect(decreaseIndent.test("    else")).toBe(false);
  });

  it("does not decrease indent on a wrapped ternary continuation", () => {
    expect(decreaseIndent.test("    else b)")).toBe(false);
  });
});
