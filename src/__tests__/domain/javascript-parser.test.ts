import { describe, it, expect } from "vitest";
import { JavaScriptParser } from "../../domain/parsers/javascript.js";

const parser = new JavaScriptParser();

describe("JavaScriptParser", () => {
  describe("parse - functions", () => {
    it("parses function declaration", () => {
      const result = parser.parse(
        'function greet(name) { return "hello " + name; }',
        "/test.js",
      );
      expect(result.functions).toHaveLength(1);
      expect(result.functions[0].name).toBe("greet");
      expect(result.functions[0].args).toEqual(["name"]);
      expect(result.functions[0].lineNumber).toBe(1);
    });

    it("parses arrow function assigned to variable", () => {
      const result = parser.parse(
        'const add = (a, b) => a + b;',
        "/test.js",
      );
      expect(result.functions).toHaveLength(1);
      expect(result.functions[0].name).toBe("add");
      expect(result.functions[0].args).toEqual(["a", "b"]);
    });

    it("parses async function", () => {
      const result = parser.parse(
        'async function fetchData(url) { return await fetch(url); }',
        "/test.js",
      );
      expect(result.functions[0].isAsync).toBe(true);
    });

    it("parses class methods", () => {
      const source = `
class Foo {
  constructor(x) { this.x = x; }
  bar() { return this.x; }
  get value() { return this.x; }
  static create() { return new Foo(1); }
}`;
      const result = parser.parse(source, "/test.js");
      const methods = result.functions;
      expect(methods.length).toBeGreaterThanOrEqual(4);
      const ctor = methods.find((m) => m.name === "constructor");
      expect(ctor?.kind).toBe("constructor");
      const getter = methods.find((m) => m.name === "value");
      expect(getter?.kind).toBe("getter");
      const staticMethod = methods.find((m) => m.name === "create");
      expect(staticMethod?.kind).toBe("static");
    });

    it("calculates cyclomatic complexity", () => {
      const source = `
function complex(x) {
  if (x > 0) {
    for (let i = 0; i < x; i++) {
      if (i % 2 === 0) {
        console.log(i);
      }
    }
  } else {
    while (x < 0) {
      x++;
    }
  }
}`;
      const result = parser.parse(source, "/test.js");
      expect(result.functions[0].cyclomaticComplexity).toBeGreaterThan(1);
    });
  });

  describe("parse - classes", () => {
    it("parses class declaration", () => {
      const result = parser.parse(
        "class Animal { speak() {} }",
        "/test.js",
      );
      expect(result.classes).toHaveLength(1);
      expect(result.classes[0].name).toBe("Animal");
    });

    it("parses class with extends", () => {
      const source = `
class Animal { }
class Dog extends Animal { }`;
      const result = parser.parse(source, "/test.js");
      const dog = result.classes.find((c) => c.name === "Dog");
      expect(dog?.bases).toContain("Animal");
    });

    it("parses class expression", () => {
      const result = parser.parse(
        "const MyClass = class { method() {} };",
        "/test.js",
      );
      const cls = result.classes.find((c) => c.name === "MyClass");
      expect(cls).toBeDefined();
    });
  });

  describe("parse - imports", () => {
    it("parses ES import default", () => {
      const result = parser.parse(
        'import React from "react";',
        "/test.js",
      );
      expect(result.imports).toHaveLength(1);
      expect(result.imports[0].name).toBe("React");
      expect(result.imports[0].source).toBe("react");
      expect(result.imports[0].isDefault).toBe(true);
    });

    it("parses ES named imports", () => {
      const result = parser.parse(
        'import { useState, useEffect } from "react";',
        "/test.js",
      );
      expect(result.imports).toHaveLength(2);
      expect(result.imports.map((i) => i.name)).toContain("useState");
      expect(result.imports.map((i) => i.name)).toContain("useEffect");
    });

    it("parses namespace import", () => {
      const result = parser.parse(
        'import * as path from "node:path";',
        "/test.js",
      );
      expect(result.imports[0].name).toBe("path");
      expect(result.imports[0].isNamespace).toBe(true);
    });

    it("parses require() call", () => {
      const result = parser.parse(
        'const fs = require("fs");',
        "/test.js",
      );
      expect(result.imports).toHaveLength(1);
      expect(result.imports[0].name).toBe("fs");
      expect(result.imports[0].source).toBe("fs");
    });
  });

  describe("parse - calls", () => {
    it("parses function calls with caller context", () => {
      const source = `
function main() {
  greet("world");
}`;
      const result = parser.parse(source, "/test.js");
      const call = result.calls.find((c) => c.name === "greet");
      expect(call).toBeDefined();
      expect(call?.callerName).toBe("main");
    });

    it("parses method calls", () => {
      const source = `
function test() {
  console.log("hello");
}`;
      const result = parser.parse(source, "/test.js");
      const call = result.calls.find((c) => c.name === "log");
      expect(call?.fullCallName).toBe("console.log");
      expect(call?.inferredObjType).toBe("console");
    });

    it("parses new expressions", () => {
      const source = `
function test() {
  const x = new Map();
}`;
      const result = parser.parse(source, "/test.js");
      const call = result.calls.find((c) => c.fullCallName === "new Map");
      expect(call).toBeDefined();
    });
  });

  describe("parse - variables", () => {
    it("parses const/let/var declarations", () => {
      const result = parser.parse(
        'const x = 42;\nlet y = "hello";\nvar z = true;',
        "/test.js",
      );
      expect(result.variables.length).toBeGreaterThanOrEqual(3);
      const x = result.variables.find((v) => v.name === "x");
      expect(x?.type).toBe("const");
      expect(x?.value).toBe("42");
    });

    it("skips variables in dependency mode", () => {
      const result = parser.parse("const x = 42;", "/test.js", true);
      expect(result.variables).toHaveLength(0);
    });
  });

  describe("preScan", () => {
    it("collects exported symbols", () => {
      const map = parser.preScan([
        {
          filePath: "/a.js",
          sourceCode: "export function foo() {}",
        },
        {
          filePath: "/b.js",
          sourceCode: "export class Bar {}",
        },
      ]);
      expect(map.has("foo")).toBe(true);
      expect(map.has("Bar")).toBe(true);
    });

    it("collects top-level declarations", () => {
      const map = parser.preScan([
        {
          filePath: "/a.js",
          sourceCode: "function helper() {}\nclass Utils {}",
        },
      ]);
      expect(map.has("helper")).toBe(true);
      expect(map.has("Utils")).toBe(true);
    });
  });

  describe("file metadata", () => {
    it("sets correct path and language", () => {
      const result = parser.parse("", "/src/main.js");
      expect(result.path).toBe("/src/main.js");
      expect(result.lang).toBe("javascript");
    });
  });
});
