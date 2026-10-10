import type {
  PropertySetView,
  PropertyValue,
  QuantityQueryOperator,
} from "./types";

import { compileTextMatcher } from "./text-match";

export class QuantityExpressionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "QuantityExpressionError";
  }
}

type Token =
  | { kind: "number"; value: number }
  | { kind: "identifier"; value: string }
  | { kind: "operator"; value: "+" | "-" | "*" | "/" | "^" }
  | { kind: "left" }
  | { kind: "right" }
  | { kind: "end" };

type Expression =
  | { kind: "number"; value: number }
  | { kind: "variable"; name: string }
  | { kind: "unary"; operator: "+" | "-"; value: Expression }
  | {
      kind: "binary";
      operator: "+" | "-" | "*" | "/" | "^";
      left: Expression;
      right: Expression;
    };

function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let index = 0;
  while (index < source.length) {
    const char = source[index];
    if (/\s/.test(char)) {
      index += 1;
      continue;
    }
    if (/[0-9.]/.test(char)) {
      const match = source.slice(index).match(/^(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?/);
      if (!match) throw new QuantityExpressionError(`Invalid number at position ${index + 1}.`);
      const value = Number(match[0]);
      if (!Number.isFinite(value)) throw new QuantityExpressionError(`Invalid number “${match[0]}”.`);
      tokens.push({ kind: "number", value });
      index += match[0].length;
      continue;
    }
    if (/[A-Za-z_]/.test(char)) {
      const value = source.slice(index).match(/^[A-Za-z_][A-Za-z0-9_]*/)![0];
      tokens.push({ kind: "identifier", value });
      index += value.length;
      continue;
    }
    if (char === "(") tokens.push({ kind: "left" });
    else if (char === ")") tokens.push({ kind: "right" });
    else if (char === "+" || char === "-" || char === "*" || char === "/" || char === "^") {
      tokens.push({ kind: "operator", value: char });
    } else {
      throw new QuantityExpressionError(`Unexpected character “${char}” at position ${index + 1}.`);
    }
    index += 1;
  }
  tokens.push({ kind: "end" });
  return tokens;
}

function parse(source: string): Expression {
  if (!source.trim()) throw new QuantityExpressionError("Enter a formula.");
  const tokens = tokenize(source);
  let index = 0;
  const peek = () => tokens[index];
  const consume = () => tokens[index++];

  const primary = (): Expression => {
    const token = consume();
    if (token.kind === "number") return { kind: "number", value: token.value };
    if (token.kind === "identifier") return { kind: "variable", name: token.value };
    if (token.kind === "left") {
      const value = additive();
      if (consume().kind !== "right") throw new QuantityExpressionError("Missing closing parenthesis.");
      return value;
    }
    throw new QuantityExpressionError("Expected a number, source alias, or parenthesis.");
  };

  const unary = (): Expression => {
    const token = peek();
    if (token.kind === "operator" && (token.value === "+" || token.value === "-")) {
      consume();
      return { kind: "unary", operator: token.value, value: unary() };
    }
    return primary();
  };

  const power = (): Expression => {
    const left = unary();
    const token = peek();
    if (token.kind === "operator" && token.value === "^") {
      consume();
      return { kind: "binary", operator: "^", left, right: power() };
    }
    return left;
  };

  const multiplicative = (): Expression => {
    let left = power();
    while (true) {
      const next = peek();
      if (next.kind !== "operator" || (next.value !== "*" && next.value !== "/")) break;
      const operator = next.value;
      consume();
      left = { kind: "binary", operator, left, right: power() };
    }
    return left;
  };

  const additive = (): Expression => {
    let left = multiplicative();
    while (true) {
      const next = peek();
      if (next.kind !== "operator" || (next.value !== "+" && next.value !== "-")) break;
      const operator = next.value;
      consume();
      left = { kind: "binary", operator, left, right: multiplicative() };
    }
    return left;
  };

  const expression = additive();
  if (peek().kind !== "end") throw new QuantityExpressionError("Unexpected content after the formula.");
  return expression;
}

function calculate(expression: Expression, variables: Record<string, number>): number {
  if (expression.kind === "number") return expression.value;
  if (expression.kind === "variable") {
    const value = variables[expression.name];
    if (!Number.isFinite(value)) {
      throw new QuantityExpressionError(`Source “${expression.name}” has no numeric value.`);
    }
    return value;
  }
  if (expression.kind === "unary") {
    const value = calculate(expression.value, variables);
    return expression.operator === "-" ? -value : value;
  }
  const left = calculate(expression.left, variables);
  const right = calculate(expression.right, variables);
  let value: number;
  switch (expression.operator) {
    case "+": value = left + right; break;
    case "-": value = left - right; break;
    case "*": value = left * right; break;
    case "/":
      if (right === 0) throw new QuantityExpressionError("Division by zero.");
      value = left / right;
      break;
    case "^": value = left ** right; break;
  }
  if (!Number.isFinite(value)) throw new QuantityExpressionError("The formula produced a non-finite value.");
  return value;
}

export function compileQuantityExpression(source: string) {
  const expression = parse(source);
  return (variables: Record<string, number>) => calculate(expression, variables);
}

export function asFiniteNumber(value: PropertyValue): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value !== "string" || !value.trim()) return null;
  const numeric = Number(value.replace(",", "."));
  return Number.isFinite(numeric) ? numeric : null;
}

function comparable(value: PropertyValue): string {
  if (typeof value === "boolean") return value ? "true" : "false";
  return String(value ?? "").trim().toLocaleLowerCase();
}

export function matchesPropertyCondition(
  actual: PropertyValue | undefined,
  operator: QuantityQueryOperator,
  expected: string,
): boolean {
  if (operator === "exists") return actual !== undefined && actual !== null && actual !== "";
  if (actual === undefined || actual === null) return false;
  // `/pattern/` is a regular expression for the three text operators; see
  // `text-match.ts`. Plain text keeps its original meaning.
  const pattern = /^\/.+\/[a-z]*$/.test(expected.trim()) ? compileTextMatcher(expected) : null;
  if (pattern) {
    const text = typeof actual === "boolean" ? (actual ? "true" : "false") : String(actual ?? "");
    if (operator === "equals" || operator === "contains") return pattern.test(text);
    if (operator === "notEquals") return !pattern.test(text);
  }
  if (operator === "equals") return comparable(actual) === comparable(expected);
  if (operator === "notEquals") return comparable(actual) !== comparable(expected);
  if (operator === "contains") return comparable(actual).includes(comparable(expected));

  const left = asFiniteNumber(actual);
  const right = asFiniteNumber(expected);
  if (left === null || right === null) return false;
  if (operator === "greaterThan") return left > right;
  if (operator === "greaterOrEqual") return left >= right;
  if (operator === "lessThan") return left < right;
  return left <= right;
}

export function findSetValue(
  sets: PropertySetView[],
  setName: string,
  valueName: string,
): PropertyValue | undefined {
  // Names may be `/regex/` too; plain names still compare case-insensitively.
  const wantedSet = compileTextMatcher(setName);
  const wantedValue = compileTextMatcher(valueName);
  for (const set of sets) {
    if (!wantedSet.test(set.name)) continue;
    const property = set.properties.find((entry) => wantedValue.test(entry.name));
    if (property) return property.value;
  }
  return undefined;
}
