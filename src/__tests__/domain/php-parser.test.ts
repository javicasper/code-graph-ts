import { describe, it, expect } from "vitest";
import { PHPParser } from "../../domain/parsers/php.js";

const parser = new PHPParser();

describe("PHPParser", () => {
  it("parses PHP function", () => {
    const source = '<?php\nfunction greet($name) { return "hello " . $name; }';
    const result = parser.parse(source, "/test.php");
    expect(result.functions).toHaveLength(1);
    expect(result.functions[0].name).toBe("greet");
    expect(result.functions[0].args).toEqual(["$name"]);
    expect(result.lang).toBe("php");
  });

  it("parses PHP class", () => {
    const source = `<?php
class User {
  private $name;
  public function __construct($name) { $this->name = $name; }
  public function getName() { return $this->name; }
}`;
    const result = parser.parse(source, "/test.php");
    const userClass = result.classes.find((c) => c.name === "User");
    expect(userClass).toBeDefined();
    const ctor = result.functions.find((f) => f.name === "__construct");
    expect(ctor?.kind).toBe("constructor");
  });

  it("parses PHP class with extends and implements", () => {
    const source = `<?php
interface Printable { public function print(); }
class BaseModel {}
class User extends BaseModel implements Printable {
  public function print() {}
}`;
    const result = parser.parse(source, "/test.php");
    const user = result.classes.find((c) => c.name === "User");
    expect(user?.bases).toContain("BaseModel");
    expect(user?.implements).toContain("Printable");
  });

  it("parses PHP interface", () => {
    const source = `<?php
interface Loggable {
  public function log($message);
}`;
    const result = parser.parse(source, "/test.php");
    const iface = result.classes.find((c) => c.name === "Loggable");
    expect(iface?.isInterface).toBe(true);
  });

  it("parses PHP use imports", () => {
    const source = `<?php
use App\\Models\\User;
use App\\Services\\Auth as AuthService;`;
    const result = parser.parse(source, "/test.php");
    const userImport = result.imports.find((i) => i.name === "User");
    expect(userImport?.source).toBe("App\\Models\\User");
  });

  it("parses PHP function calls", () => {
    const source = `<?php
function main() {
  greet("world");
  $user->getName();
  User::find(1);
}`;
    const result = parser.parse(source, "/test.php");
    expect(result.calls.length).toBeGreaterThanOrEqual(3);
  });

  it("parses PHP variables", () => {
    const source = `<?php
class Config {
  public $debug = true;
  const VERSION = "1.0";
}`;
    const result = parser.parse(source, "/test.php");
    expect(result.variables.length).toBeGreaterThanOrEqual(1);
    const debugVar = result.variables.find((v) => v.name === "$debug");
    expect(debugVar).toBeDefined();
  });

  describe("preScan", () => {
    it("collects PHP symbols", () => {
      const map = parser.preScan([
        {
          filePath: "/a.php",
          sourceCode: "<?php\nfunction helper() {}\nclass Utils {}",
        },
      ]);
      expect(map.has("helper")).toBe(true);
      expect(map.has("Utils")).toBe(true);
    });
  });
});
