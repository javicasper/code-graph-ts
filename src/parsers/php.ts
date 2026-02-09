import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import type TreeSitter from "tree-sitter";
import { BaseParser } from "./base-parser.js";
import type {
  ParsedFile,
  ParsedFunction,
  ParsedClass,
  ParsedImport,
  ParsedCall,
  ParsedVariable,
  ImportsMap,
} from "../core/types.js";

const require = createRequire(import.meta.url);

export class PHPParser extends BaseParser {
  readonly supportedExtensions = [".php"];
  readonly languageName = "php";

  constructor() {
    const phpGrammar = require("tree-sitter-php");
    super(phpGrammar.php);
  }

  // ── Public API ──────────────────────────────────────────────

  parse(filePath: string, isDependency = false): ParsedFile {
    const { source, tree } = this.readAndParse(filePath);
    const repoPath = "";
    const result = this.emptyParsedFile(filePath, repoPath);
    result.lang = "php";
    const root = tree.rootNode;

    this.extractFunctions(root, result, source, isDependency);
    this.extractClasses(root, result, source, isDependency);
    this.extractImports(root, result);
    this.extractCalls(root, result);
    if (!isDependency) {
      this.extractVariables(root, result);
    }

    return result;
  }

  preScan(files: string[]): ImportsMap {
    const map: ImportsMap = new Map();

    for (const filePath of files) {
      let source: string;
      try {
        source = readFileSync(filePath, "utf-8");
      } catch {
        continue;
      }
      const tree = this.parseSource(source);
      const root = tree.rootNode;

      // Collect all function/class definitions
      for (const node of root.descendantsOfType("function_definition")) {
        const name = this.getFieldText(node, "name");
        if (name) {
          if (!map.has(name)) map.set(name, []);
          map.get(name)!.push({ filePath, lineNumber: node.startPosition.row + 1 });
        }
      }
      for (const node of root.descendantsOfType("method_declaration")) {
        const name = this.getFieldText(node, "name");
        if (name) {
          if (!map.has(name)) map.set(name, []);
          map.get(name)!.push({ filePath, lineNumber: node.startPosition.row + 1 });
        }
      }
      for (const node of root.descendantsOfType("class_declaration")) {
        const name = this.getFieldText(node, "name");
        if (name) {
          if (!map.has(name)) map.set(name, []);
          map.get(name)!.push({ filePath, lineNumber: node.startPosition.row + 1 });
        }
      }
      for (const node of root.descendantsOfType("interface_declaration")) {
        const name = this.getFieldText(node, "name");
        if (name) {
          if (!map.has(name)) map.set(name, []);
          map.get(name)!.push({ filePath, lineNumber: node.startPosition.row + 1 });
        }
      }
      for (const node of root.descendantsOfType("trait_declaration")) {
        const name = this.getFieldText(node, "name");
        if (name) {
          if (!map.has(name)) map.set(name, []);
          map.get(name)!.push({ filePath, lineNumber: node.startPosition.row + 1 });
        }
      }
    }

    return map;
  }

  // ── Extract functions ───────────────────────────────────────

  private extractFunctions(
    root: TreeSitter.SyntaxNode,
    result: ParsedFile,
    source: string,
    isDependency: boolean,
  ): void {
    // Top-level functions
    for (const node of root.descendantsOfType("function_definition")) {
      const fn = this.parsePHPFunction(node, source, isDependency);
      if (fn) result.functions.push(fn);
    }

    // Class methods
    for (const node of root.descendantsOfType("method_declaration")) {
      const fn = this.parsePHPMethod(node, source, isDependency);
      if (fn) result.functions.push(fn);
    }
  }

  private parsePHPFunction(
    node: TreeSitter.SyntaxNode,
    source: string,
    isDependency: boolean,
  ): ParsedFunction | null {
    const name = this.getFieldText(node, "name");
    if (!name) return null;

    const params = node.childForFieldName("parameters");
    const args = params ? this.extractPHPParams(params) : [];
    const body = node.childForFieldName("body");

    return {
      name,
      lineNumber: node.startPosition.row + 1,
      endLine: node.endPosition.row + 1,
      args,
      source: isDependency ? undefined : node.text,
      docstring: this.extractDocstring(node),
      cyclomaticComplexity: body ? this.calculateCyclomaticComplexity(body) : 1,
      context: this.findEnclosingFunction(node)?.name,
      classContext: this.findEnclosingClass(node),
    };
  }

  private parsePHPMethod(
    node: TreeSitter.SyntaxNode,
    source: string,
    isDependency: boolean,
  ): ParsedFunction | null {
    const name = this.getFieldText(node, "name");
    if (!name) return null;

    const params = node.childForFieldName("parameters");
    const args = params ? this.extractPHPParams(params) : [];
    const body = node.childForFieldName("body");

    // Detect visibility/static modifiers
    let kind: ParsedFunction["kind"];
    const modifiers = node.descendantsOfType("static_modifier");
    if (modifiers.length > 0) kind = "static";
    if (name === "__construct") kind = "constructor";

    // Check for abstract
    const isAbstractMethod = node.descendantsOfType("abstract_modifier").length > 0;

    const decorators: string[] = [];
    // PHP attributes (#[...])
    const attributes = node.descendantsOfType("attribute_list");
    for (const attr of attributes) {
      decorators.push(attr.text);
    }

    return {
      name,
      lineNumber: node.startPosition.row + 1,
      endLine: node.endPosition.row + 1,
      args,
      source: isDependency ? undefined : node.text,
      docstring: this.extractDocstring(node),
      cyclomaticComplexity: body ? this.calculateCyclomaticComplexity(body) : 1,
      classContext: this.findEnclosingClass(node),
      kind,
      decorators: decorators.length > 0 ? decorators : undefined,
    };
  }

  // ── Extract classes ─────────────────────────────────────────

  private extractClasses(
    root: TreeSitter.SyntaxNode,
    result: ParsedFile,
    source: string,
    isDependency: boolean,
  ): void {
    for (const node of root.descendantsOfType("class_declaration")) {
      const cls = this.parsePHPClass(node, source, isDependency);
      if (cls) result.classes.push(cls);
    }
    for (const node of root.descendantsOfType("interface_declaration")) {
      const cls = this.parsePHPInterface(node, source, isDependency);
      if (cls) result.classes.push(cls);
    }
    for (const node of root.descendantsOfType("trait_declaration")) {
      const cls = this.parsePHPTrait(node, source, isDependency);
      if (cls) result.classes.push(cls);
    }
  }

  private parsePHPClass(
    node: TreeSitter.SyntaxNode,
    source: string,
    isDependency: boolean,
  ): ParsedClass | null {
    const name = this.getFieldText(node, "name");
    if (!name) return null;

    const bases: string[] = [];
    const impls: string[] = [];

    // extends
    const baseClause = node.childForFieldName("base_clause") ??
      node.descendantsOfType("base_clause")[0];
    if (baseClause) {
      for (let i = 0; i < baseClause.namedChildCount; i++) {
        const child = baseClause.namedChild(i)!;
        if (child.type === "name" || child.type === "qualified_name") {
          bases.push(child.text);
        }
      }
    }

    // implements
    const implClause = node.descendantsOfType("class_interface_clause");
    for (const ic of implClause) {
      for (let i = 0; i < ic.namedChildCount; i++) {
        const child = ic.namedChild(i)!;
        if (child.type === "name" || child.type === "qualified_name") {
          impls.push(child.text);
        }
      }
    }

    const isAbstract =
      node.descendantsOfType("abstract_modifier").length > 0 ||
      node.parent?.children.some((c) => c.text === "abstract") === true;

    return {
      name,
      lineNumber: node.startPosition.row + 1,
      endLine: node.endPosition.row + 1,
      bases,
      implements: impls.length > 0 ? impls : undefined,
      source: isDependency ? undefined : node.text,
      docstring: this.extractDocstring(node),
      isAbstract,
    };
  }

  private parsePHPInterface(
    node: TreeSitter.SyntaxNode,
    source: string,
    isDependency: boolean,
  ): ParsedClass | null {
    const name = this.getFieldText(node, "name");
    if (!name) return null;

    const bases: string[] = [];
    const baseClause = node.descendantsOfType("base_clause");
    for (const bc of baseClause) {
      for (let i = 0; i < bc.namedChildCount; i++) {
        const child = bc.namedChild(i)!;
        if (child.type === "name" || child.type === "qualified_name") {
          bases.push(child.text);
        }
      }
    }

    return {
      name,
      lineNumber: node.startPosition.row + 1,
      endLine: node.endPosition.row + 1,
      bases,
      source: isDependency ? undefined : node.text,
      docstring: this.extractDocstring(node),
      isInterface: true,
    };
  }

  private parsePHPTrait(
    node: TreeSitter.SyntaxNode,
    source: string,
    isDependency: boolean,
  ): ParsedClass | null {
    const name = this.getFieldText(node, "name");
    if (!name) return null;

    return {
      name,
      lineNumber: node.startPosition.row + 1,
      endLine: node.endPosition.row + 1,
      bases: [],
      source: isDependency ? undefined : node.text,
      docstring: this.extractDocstring(node),
    };
  }

  // ── Extract imports ─────────────────────────────────────────

  private extractImports(
    root: TreeSitter.SyntaxNode,
    result: ParsedFile,
  ): void {
    // namespace use declarations: use App\Foo\Bar;
    for (const node of root.descendantsOfType("namespace_use_declaration")) {
      for (const clause of node.descendantsOfType("namespace_use_clause")) {
        // The qualified_name child holds the full namespace path
        const qName = clause.descendantsOfType("qualified_name")[0];
        const nameNode = qName ?? clause.namedChild(0);
        if (!nameNode) continue;
        const fullName = nameNode.text;
        const parts = fullName.split("\\");
        const shortName = parts[parts.length - 1]!;

        // Check for alias (as)
        const aliasNode = clause.childForFieldName("alias");
        const alias = aliasNode?.text;

        result.imports.push({
          name: alias ?? shortName,
          source: fullName,
          alias: alias ? shortName : undefined,
          lineNumber: node.startPosition.row + 1,
        });
      }
    }

    // include/require statements
    for (const node of root.descendantsOfType("include_expression")) {
      const arg = node.namedChild(0);
      if (arg) {
        result.imports.push({
          name: arg.text.replace(/['"]/g, ""),
          source: arg.text.replace(/['"]/g, ""),
          lineNumber: node.startPosition.row + 1,
        });
      }
    }
  }

  // ── Extract calls ───────────────────────────────────────────

  private extractCalls(
    root: TreeSitter.SyntaxNode,
    result: ParsedFile,
  ): void {
    // Function calls
    for (const node of root.descendantsOfType("function_call_expression")) {
      const fnNode = node.childForFieldName("function");
      if (!fnNode) continue;
      const name = fnNode.text;
      const argsNode = node.childForFieldName("arguments");
      const args = argsNode ? this.extractPHPArgTexts(argsNode) : [];
      const caller = this.findEnclosingFunction(node);

      result.calls.push({
        name,
        lineNumber: node.startPosition.row + 1,
        args,
        callerName: caller?.name,
        callerLineNumber: caller?.lineNumber,
      });
    }

    // Method calls: $obj->method()
    for (const node of root.descendantsOfType("member_call_expression")) {
      const obj = node.childForFieldName("object");
      const method = node.childForFieldName("name");
      if (!method) continue;
      const argsNode = node.childForFieldName("arguments");
      const args = argsNode ? this.extractPHPArgTexts(argsNode) : [];
      const caller = this.findEnclosingFunction(node);

      result.calls.push({
        name: method.text,
        lineNumber: node.startPosition.row + 1,
        args,
        callerName: caller?.name,
        callerLineNumber: caller?.lineNumber,
        fullCallName: node.text.split("(")[0],
        inferredObjType: obj?.text,
      });
    }

    // Static calls: Class::method()
    for (const node of root.descendantsOfType("scoped_call_expression")) {
      const scope = node.childForFieldName("scope");
      const method = node.childForFieldName("name");
      if (!method) continue;
      const argsNode = node.childForFieldName("arguments");
      const args = argsNode ? this.extractPHPArgTexts(argsNode) : [];
      const caller = this.findEnclosingFunction(node);

      result.calls.push({
        name: method.text,
        lineNumber: node.startPosition.row + 1,
        args,
        callerName: caller?.name,
        callerLineNumber: caller?.lineNumber,
        fullCallName: `${scope?.text}::${method.text}`,
        inferredObjType: scope?.text,
      });
    }

    // new ClassName()
    for (const node of root.descendantsOfType("object_creation_expression")) {
      const classNode = node.namedChild(0);
      if (!classNode) continue;
      const name = classNode.text;
      const argsNode = node.childForFieldName("arguments");
      const args = argsNode ? this.extractPHPArgTexts(argsNode) : [];
      const caller = this.findEnclosingFunction(node);

      result.calls.push({
        name,
        lineNumber: node.startPosition.row + 1,
        args,
        callerName: caller?.name,
        callerLineNumber: caller?.lineNumber,
        fullCallName: `new ${name}`,
      });
    }
  }

  // ── Extract variables ───────────────────────────────────────

  private extractVariables(
    root: TreeSitter.SyntaxNode,
    result: ParsedFile,
  ): void {
    // Property declarations in classes
    for (const node of root.descendantsOfType("property_declaration")) {
      for (const elem of node.descendantsOfType("property_element")) {
        const varNode = elem.descendantsOfType("variable_name")[0];
        if (!varNode) continue;
        const name = varNode.text;
        const value = elem.childForFieldName("value")?.text;

        result.variables.push({
          name,
          lineNumber: node.startPosition.row + 1,
          value: value?.substring(0, 200),
          classContext: this.findEnclosingClass(node),
        });
      }
    }

    // Const declarations
    for (const node of root.descendantsOfType("const_declaration")) {
      for (const elem of node.descendantsOfType("const_element")) {
        const name = this.getFieldText(elem, "name");
        if (!name) continue;
        const value = this.getFieldText(elem, "value");

        result.variables.push({
          name,
          lineNumber: node.startPosition.row + 1,
          value: value?.substring(0, 200),
          type: "const",
          classContext: this.findEnclosingClass(node),
        });
      }
    }
  }

  // ── Helpers ─────────────────────────────────────────────────

  private extractPHPParams(paramsNode: TreeSitter.SyntaxNode): string[] {
    const names: string[] = [];
    for (let i = 0; i < paramsNode.namedChildCount; i++) {
      const param = paramsNode.namedChild(i)!;
      if (param.type === "simple_parameter" || param.type === "variadic_parameter") {
        const nameNode = param.childForFieldName("name");
        if (nameNode) names.push(nameNode.text);
      } else if (param.type === "property_promotion_parameter") {
        const nameNode = param.childForFieldName("name");
        if (nameNode) names.push(nameNode.text);
      }
    }
    return names;
  }

  private extractPHPArgTexts(argsNode: TreeSitter.SyntaxNode): string[] {
    const args: string[] = [];
    for (let i = 0; i < argsNode.namedChildCount; i++) {
      const arg = argsNode.namedChild(i)!;
      if (arg.type === "argument") {
        args.push(arg.text.substring(0, 100));
      } else {
        args.push(arg.text.substring(0, 100));
      }
    }
    return args;
  }
}
