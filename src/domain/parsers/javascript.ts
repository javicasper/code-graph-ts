import { createRequire } from "node:module";
import type TreeSitter from "tree-sitter";
import { BaseParser } from "./base-parser.js";
import type {
  ParsedFile,
  ParsedFunction,
  ParsedClass,
  ParsedCall,
  ImportsMap,
} from "../types.js";

const require = createRequire(import.meta.url);

export class JavaScriptParser extends BaseParser {
  readonly supportedExtensions = [".js", ".jsx", ".mjs", ".cjs"];
  readonly languageName: string = "javascript";

  constructor(language?: unknown) {
    super(language ?? require("tree-sitter-javascript"));
  }

  // ── Public API ──────────────────────────────────────────────

  parse(sourceCode: string, filePath: string, isDependency = false): ParsedFile {
    const tree = this.parseSource(sourceCode);
    const result = this.emptyParsedFile(filePath);
    const root = tree.rootNode;

    this.extractFunctions(root, result, isDependency);
    this.extractClasses(root, result, isDependency);
    this.extractImports(root, result);
    this.extractCalls(root, result);
    if (!isDependency) {
      this.extractVariables(root, result);
    }

    return result;
  }

  preScan(files: { filePath: string; sourceCode: string }[]): ImportsMap {
    const map: ImportsMap = new Map();

    for (const { filePath, sourceCode } of files) {
      const tree = this.parseSource(sourceCode);
      const root = tree.rootNode;

      this.collectExportedSymbols(root, filePath, map);

      for (const node of root.descendantsOfType("function_declaration")) {
        const name = this.getFieldText(node, "name");
        if (name) {
          const lineNumber = node.startPosition.row + 1;
          if (!map.has(name)) map.set(name, []);
          map.get(name)!.push({ filePath, lineNumber });
        }
      }
      for (const node of root.descendantsOfType("class_declaration")) {
        const name = this.getFieldText(node, "name");
        if (name) {
          const lineNumber = node.startPosition.row + 1;
          if (!map.has(name)) map.set(name, []);
          map.get(name)!.push({ filePath, lineNumber });
        }
      }
    }

    return map;
  }

  // ── Extract functions ───────────────────────────────────────

  protected extractFunctions(
    root: TreeSitter.SyntaxNode,
    result: ParsedFile,
    isDependency: boolean,
  ): void {
    for (const node of root.descendantsOfType("function_declaration")) {
      const fn = this.parseFunctionDeclaration(node, isDependency);
      if (fn) result.functions.push(fn);
    }

    for (const node of root.descendantsOfType("variable_declarator")) {
      const valueNode = node.childForFieldName("value");
      if (
        valueNode &&
        (valueNode.type === "arrow_function" ||
          valueNode.type === "function_expression" ||
          valueNode.type === "function")
      ) {
        const fn = this.parseVariableFunction(node, valueNode, isDependency);
        if (fn) result.functions.push(fn);
      }
    }

    for (const node of root.descendantsOfType("method_definition")) {
      const fn = this.parseMethodDefinition(node, isDependency);
      if (fn) result.functions.push(fn);
    }
  }

  protected parseFunctionDeclaration(
    node: TreeSitter.SyntaxNode,
    isDependency: boolean,
  ): ParsedFunction | null {
    const name = this.getFieldText(node, "name");
    if (!name) return null;

    const params = node.childForFieldName("parameters");
    const args = params ? this.extractParamNames(params) : [];
    const body = node.childForFieldName("body");
    const isAsync = node.children.some((c) => c.type === "async");

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
      isAsync,
    };
  }

  protected parseVariableFunction(
    varNode: TreeSitter.SyntaxNode,
    fnNode: TreeSitter.SyntaxNode,
    isDependency: boolean,
  ): ParsedFunction | null {
    const name = this.getFieldText(varNode, "name");
    if (!name) return null;

    const params = fnNode.childForFieldName("parameters");
    const args = params ? this.extractParamNames(params) : [];
    const body = fnNode.childForFieldName("body");
    const isAsync = fnNode.children.some((c) => c.type === "async");

    return {
      name,
      lineNumber: varNode.startPosition.row + 1,
      endLine: fnNode.endPosition.row + 1,
      args,
      source: isDependency ? undefined : varNode.parent?.text ?? varNode.text,
      docstring: this.extractDocstring(varNode.parent ?? varNode),
      cyclomaticComplexity: body ? this.calculateCyclomaticComplexity(body) : 1,
      context: this.findEnclosingFunction(varNode)?.name,
      classContext: this.findEnclosingClass(varNode),
      isAsync,
    };
  }

  protected parseMethodDefinition(
    node: TreeSitter.SyntaxNode,
    isDependency: boolean,
  ): ParsedFunction | null {
    const name = this.getFieldText(node, "name");
    if (!name) return null;

    const params = node.childForFieldName("parameters");
    const args = params ? this.extractParamNames(params) : [];
    const body = node.childForFieldName("body");
    const isAsync = node.children.some((c) => c.type === "async");

    let kind: ParsedFunction["kind"];
    const firstChild = node.child(0);
    if (firstChild?.text === "get") kind = "getter";
    else if (firstChild?.text === "set") kind = "setter";
    else if (firstChild?.text === "static") kind = "static";
    if (name === "constructor") kind = "constructor";

    const decorators: string[] = [];
    const prev = node.previousNamedSibling;
    if (prev?.type === "decorator") {
      decorators.push(prev.text);
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
      isAsync,
      kind,
      decorators: decorators.length > 0 ? decorators : undefined,
    };
  }

  // ── Extract classes ─────────────────────────────────────────

  protected extractClasses(
    root: TreeSitter.SyntaxNode,
    result: ParsedFile,
    isDependency: boolean,
  ): void {
    for (const node of root.descendantsOfType("class_declaration")) {
      const cls = this.parseClassNode(node, isDependency);
      if (cls) result.classes.push(cls);
    }
    for (const node of root.descendantsOfType("class")) {
      if (node.type === "class" && node.parent?.type === "variable_declarator") {
        const name = this.getFieldText(node.parent, "name");
        if (name) {
          const cls = this.parseClassNode(node, isDependency, name);
          if (cls) result.classes.push(cls);
        }
      }
    }
  }

  protected parseClassNode(
    node: TreeSitter.SyntaxNode,
    isDependency: boolean,
    overrideName?: string,
  ): ParsedClass | null {
    const name = overrideName ?? this.getFieldText(node, "name");
    if (!name) return null;

    const bases: string[] = [];
    const heritage = node.descendantsOfType("class_heritage");
    for (const h of heritage) {
      for (let i = 0; i < h.childCount; i++) {
        const child = h.child(i)!;
        if (child.type !== "extends" && child.type !== "implements") {
          if (child.type === "identifier" || child.type === "type_identifier") {
            bases.push(child.text);
          }
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
    };
  }

  // ── Extract imports ─────────────────────────────────────────

  protected extractImports(
    root: TreeSitter.SyntaxNode,
    result: ParsedFile,
  ): void {
    for (const node of root.descendantsOfType("import_statement")) {
      this.parseImportStatement(node, result);
    }

    for (const node of root.descendantsOfType("call_expression")) {
      const fn = node.childForFieldName("function");
      if (fn?.text === "require") {
        const args = node.childForFieldName("arguments");
        if (args && args.namedChildCount > 0) {
          const srcNode = args.namedChild(0)!;
          const source = srcNode.text.replace(/['"]/g, "");
          let name = source;
          if (node.parent?.type === "variable_declarator") {
            name = this.getFieldText(node.parent, "name") ?? source;
          }
          result.imports.push({
            name,
            source,
            lineNumber: node.startPosition.row + 1,
          });
        }
      }
    }
  }

  protected parseImportStatement(
    node: TreeSitter.SyntaxNode,
    result: ParsedFile,
  ): void {
    const sourceNode = node.childForFieldName("source");
    if (!sourceNode) return;
    const source = sourceNode.text.replace(/['"]/g, "");
    const lineNumber = node.startPosition.row + 1;

    for (let i = 0; i < node.namedChildCount; i++) {
      const child = node.namedChild(i)!;

      if (child.type === "import_clause") {
        for (let j = 0; j < child.namedChildCount; j++) {
          const part = child.namedChild(j)!;

          if (part.type === "identifier") {
            result.imports.push({ name: part.text, source, lineNumber, isDefault: true });
          } else if (part.type === "named_imports") {
            for (const spec of part.descendantsOfType("import_specifier")) {
              const importedName = this.getFieldText(spec, "name");
              const alias = this.getFieldText(spec, "alias");
              if (importedName) {
                result.imports.push({
                  name: alias ?? importedName,
                  source,
                  alias: alias ? importedName : undefined,
                  lineNumber,
                });
              }
            }
          } else if (part.type === "namespace_import") {
            const name = part.namedChild(0)?.text;
            if (name) {
              result.imports.push({ name, source, lineNumber, isNamespace: true });
            }
          }
        }
      }
    }
  }

  // ── Extract calls ───────────────────────────────────────────

  protected extractCalls(
    root: TreeSitter.SyntaxNode,
    result: ParsedFile,
  ): void {
    for (const node of root.descendantsOfType("call_expression")) {
      const call = this.parseCallExpression(node);
      if (call) result.calls.push(call);
    }

    for (const node of root.descendantsOfType("new_expression")) {
      const constructor = node.childForFieldName("constructor");
      if (constructor) {
        const name = constructor.text;
        const argsNode = node.childForFieldName("arguments");
        const args = argsNode ? this.extractArgTexts(argsNode) : [];
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
  }

  protected parseCallExpression(
    node: TreeSitter.SyntaxNode,
  ): ParsedCall | null {
    const fnNode = node.childForFieldName("function");
    if (!fnNode) return null;

    let name: string;
    let fullCallName: string | undefined;
    let inferredObjType: string | undefined;

    if (fnNode.type === "member_expression") {
      const obj = fnNode.childForFieldName("object");
      const prop = fnNode.childForFieldName("property");
      name = prop?.text ?? fnNode.text;
      fullCallName = fnNode.text;
      inferredObjType = obj?.text;
    } else {
      name = fnNode.text;
    }

    if (name === "require") return null;

    const argsNode = node.childForFieldName("arguments");
    const args = argsNode ? this.extractArgTexts(argsNode) : [];
    const caller = this.findEnclosingFunction(node);

    return {
      name,
      lineNumber: node.startPosition.row + 1,
      args,
      callerName: caller?.name,
      callerLineNumber: caller?.lineNumber,
      fullCallName,
      inferredObjType,
    };
  }

  // ── Extract variables ───────────────────────────────────────

  protected extractVariables(
    root: TreeSitter.SyntaxNode,
    result: ParsedFile,
  ): void {
    for (const node of root.descendantsOfType("variable_declarator")) {
      const valueNode = node.childForFieldName("value");
      if (
        valueNode &&
        (valueNode.type === "arrow_function" ||
          valueNode.type === "function_expression" ||
          valueNode.type === "function" ||
          valueNode.type === "class")
      ) {
        continue;
      }

      const name = this.getFieldText(node, "name");
      if (!name) continue;

      const value = valueNode?.text;
      const context = this.findEnclosingFunction(node)?.name;
      const classContext = this.findEnclosingClass(node);

      let type: string | undefined;
      if (node.parent?.type === "lexical_declaration") {
        type = node.parent.child(0)?.text;
      } else if (node.parent?.type === "variable_declaration") {
        type = "var";
      }

      result.variables.push({
        name,
        lineNumber: node.startPosition.row + 1,
        value: value?.substring(0, 200),
        type,
        context,
        classContext,
      });
    }
  }

  // ── Helpers ─────────────────────────────────────────────────

  protected extractParamNames(paramsNode: TreeSitter.SyntaxNode): string[] {
    const names: string[] = [];
    for (let i = 0; i < paramsNode.namedChildCount; i++) {
      const param = paramsNode.namedChild(i)!;
      if (param.type === "identifier") {
        names.push(param.text);
      } else if (param.type === "assignment_pattern") {
        const left = param.childForFieldName("left");
        if (left) names.push(left.text);
      } else if (param.type === "rest_pattern") {
        names.push("..." + (param.namedChild(0)?.text ?? ""));
      } else if (
        param.type === "required_parameter" ||
        param.type === "optional_parameter"
      ) {
        const pattern = param.childForFieldName("pattern");
        if (pattern) names.push(pattern.text);
      } else {
        names.push(param.text);
      }
    }
    return names;
  }

  protected extractArgTexts(argsNode: TreeSitter.SyntaxNode): string[] {
    const args: string[] = [];
    for (let i = 0; i < argsNode.namedChildCount; i++) {
      const arg = argsNode.namedChild(i)!;
      args.push(arg.text.substring(0, 100));
    }
    return args;
  }

  protected collectExportedSymbols(
    root: TreeSitter.SyntaxNode,
    filePath: string,
    map: ImportsMap,
  ): void {
    for (const node of root.descendantsOfType("export_statement")) {
      const declaration = node.childForFieldName("declaration");
      if (declaration) {
        const name = this.getFieldText(declaration, "name");
        if (name) {
          const lineNumber = declaration.startPosition.row + 1;
          if (!map.has(name)) map.set(name, []);
          map.get(name)!.push({ filePath, lineNumber });
        }
      }
      for (const spec of node.descendantsOfType("export_specifier")) {
        const name = this.getFieldText(spec, "name");
        if (name) {
          const lineNumber = spec.startPosition.row + 1;
          if (!map.has(name)) map.set(name, []);
          map.get(name)!.push({ filePath, lineNumber });
        }
      }
    }
  }
}
