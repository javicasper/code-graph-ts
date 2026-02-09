import { describe, it, expect } from "vitest";
import { TypeScriptParser } from "../../domain/parsers/typescript.js";

const parser = new TypeScriptParser("typescript");

describe("TypeScriptParser", () => {
  it("parses TypeScript function with types", () => {
    const result = parser.parse(
      "function greet(name: string): string { return name; }",
      "/test.ts",
    );
    expect(result.functions).toHaveLength(1);
    expect(result.functions[0].name).toBe("greet");
    expect(result.functions[0].args).toEqual(["name"]);
    expect(result.lang).toBe("typescript");
  });

  it("parses interfaces", () => {
    const source = `
interface Printable {
  print(): void;
}
interface Serializable extends Printable {
  serialize(): string;
}`;
    const result = parser.parse(source, "/test.ts");
    const printable = result.classes.find((c) => c.name === "Printable");
    expect(printable?.isInterface).toBe(true);
    const serializable = result.classes.find((c) => c.name === "Serializable");
    expect(serializable?.isInterface).toBe(true);
    expect(serializable?.bases).toContain("Printable");
  });

  it("parses abstract classes", () => {
    const source = `
abstract class Shape {
  abstract area(): number;
}`;
    const result = parser.parse(source, "/test.ts");
    const shape = result.classes.find((c) => c.name === "Shape");
    expect(shape?.isAbstract).toBe(true);
  });

  it("parses implements clause", () => {
    const source = `
interface Flyable { fly(): void; }
class Bird implements Flyable {
  fly() {}
}`;
    const result = parser.parse(source, "/test.ts");
    const bird = result.classes.find((c) => c.name === "Bird");
    expect(bird?.implements).toContain("Flyable");
  });

  it("parses type aliases as variables", () => {
    const source = 'type ID = string | number;';
    const result = parser.parse(source, "/test.ts");
    const typeVar = result.variables.find((v) => v.name === "ID");
    expect(typeVar).toBeDefined();
    expect(typeVar?.type).toBe("type");
  });

  it("parses optional parameters", () => {
    const source = "function greet(name?: string, age: number = 0) {}";
    const result = parser.parse(source, "/test.ts");
    expect(result.functions[0].args).toEqual(["name", "age"]);
  });

  it("does not double-parse (single tree)", () => {
    // The key fix: TS parser should parse source only once
    // We verify by checking that the result is correct — if it double-parsed,
    // there would be duplicate entries
    const source = `
export class Foo {
  bar(): string { return "hello"; }
}`;
    const result = parser.parse(source, "/test.ts");
    const fooClasses = result.classes.filter((c) => c.name === "Foo");
    expect(fooClasses).toHaveLength(1);
    const barMethods = result.functions.filter((f) => f.name === "bar");
    expect(barMethods).toHaveLength(1);
  });
});
