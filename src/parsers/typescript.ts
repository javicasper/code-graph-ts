import { createRequire } from "node:module";
import type TreeSitter from "tree-sitter";
import { JavaScriptParser } from "./javascript.js";
import type {
  ParsedFile,
  ParsedClass,
  ParsedFunction,
} from "../core/types.js";

const require = createRequire(import.meta.url);

export class TypeScriptParser extends JavaScriptParser {
  override readonly supportedExtensions = [".ts", ".tsx"];
  override readonly languageName = "typescript";

  constructor(variant: "typescript" | "tsx" = "typescript") {
    const tsGrammars = require("tree-sitter-typescript");
    super(variant === "tsx" ? tsGrammars.tsx : tsGrammars.typescript);
  }

  // ── Overrides ───────────────────────────────────────────────

  override parse(filePath: string, isDependency = false): ParsedFile {
    const result = super.parse(filePath, isDependency);
    result.lang = "typescript";

    // Also extract TS-specific constructs
    const { tree } = this.readAndParse(filePath);
    const root = tree.rootNode;

    this.extractInterfaces(root, result, isDependency);
    this.extractAbstractClasses(root, result, isDependency);
    this.extractTypeAliases(root, result);

    // Re-parse classes to pick up implements clauses
    this.augmentClassesWithImplements(root, result);

    return result;
  }

  // ── TS-specific extractions ─────────────────────────────────

  private extractInterfaces(
    root: TreeSitter.SyntaxNode,
    result: ParsedFile,
    isDependency: boolean,
  ): void {
    for (const node of root.descendantsOfType("interface_declaration")) {
      const name = this.getFieldText(node, "name");
      if (!name) continue;

      const bases: string[] = [];
      // extends clause on interface
      const extendsClause = node.descendantsOfType("extends_type_clause");
      for (const ext of extendsClause) {
        for (let i = 0; i < ext.namedChildCount; i++) {
          const child = ext.namedChild(i)!;
          if (
            child.type === "type_identifier" ||
            child.type === "identifier"
          ) {
            bases.push(child.text);
          }
        }
      }

      // Avoid duplicates (interface may have already been captured as class)
      if (result.classes.some((c) => c.name === name && c.lineNumber === node.startPosition.row + 1)) {
        continue;
      }

      result.classes.push({
        name,
        lineNumber: node.startPosition.row + 1,
        endLine: node.endPosition.row + 1,
        bases,
        source: isDependency ? undefined : node.text,
        docstring: this.extractDocstring(node),
        isInterface: true,
      });
    }
  }

  private extractAbstractClasses(
    root: TreeSitter.SyntaxNode,
    result: ParsedFile,
    isDependency: boolean,
  ): void {
    for (const node of root.descendantsOfType("abstract_class_declaration")) {
      const name = this.getFieldText(node, "name");
      if (!name) continue;

      // Check if already captured
      if (result.classes.some((c) => c.name === name && c.lineNumber === node.startPosition.row + 1)) {
        // Update isAbstract flag
        const existing = result.classes.find(
          (c) => c.name === name && c.lineNumber === node.startPosition.row + 1,
        );
        if (existing) existing.isAbstract = true;
        continue;
      }

      const bases: string[] = [];
      const heritage = node.descendantsOfType("class_heritage");
      for (const h of heritage) {
        for (let i = 0; i < h.childCount; i++) {
          const child = h.child(i)!;
          if (child.type === "identifier" || child.type === "type_identifier") {
            bases.push(child.text);
          }
        }
      }

      result.classes.push({
        name,
        lineNumber: node.startPosition.row + 1,
        endLine: node.endPosition.row + 1,
        bases,
        source: isDependency ? undefined : node.text,
        docstring: this.extractDocstring(node),
        isAbstract: true,
      });
    }
  }

  private extractTypeAliases(
    root: TreeSitter.SyntaxNode,
    result: ParsedFile,
  ): void {
    for (const node of root.descendantsOfType("type_alias_declaration")) {
      const name = this.getFieldText(node, "name");
      if (!name) continue;

      result.variables.push({
        name,
        lineNumber: node.startPosition.row + 1,
        type: "type",
        value: node.childForFieldName("value")?.text?.substring(0, 200),
      });
    }
  }

  private augmentClassesWithImplements(
    root: TreeSitter.SyntaxNode,
    result: ParsedFile,
  ): void {
    // Look for class declarations with implements clause
    const classTypes = [
      ...root.descendantsOfType("class_declaration"),
      ...root.descendantsOfType("abstract_class_declaration"),
    ];

    for (const node of classTypes) {
      const name = this.getFieldText(node, "name");
      if (!name) continue;

      const cls = result.classes.find(
        (c) => c.name === name && c.lineNumber === node.startPosition.row + 1,
      );
      if (!cls) continue;

      // Find implements clause nodes
      const implNodes = node.descendantsOfType("implements_clause");
      if (implNodes.length === 0) continue;

      const impls: string[] = [];
      for (const impl of implNodes) {
        for (let i = 0; i < impl.namedChildCount; i++) {
          const child = impl.namedChild(i)!;
          if (
            child.type === "type_identifier" ||
            child.type === "identifier" ||
            child.type === "generic_type"
          ) {
            // For generic_type, get just the name
            if (child.type === "generic_type") {
              const typeName = child.namedChild(0)?.text;
              if (typeName) impls.push(typeName);
            } else {
              impls.push(child.text);
            }
          }
        }
      }

      if (impls.length > 0) {
        cls.implements = impls;
      }
    }
  }

  // Override param extraction to handle TS-specific types
  protected override extractParamNames(paramsNode: TreeSitter.SyntaxNode): string[] {
    const names: string[] = [];
    for (let i = 0; i < paramsNode.namedChildCount; i++) {
      const param = paramsNode.namedChild(i)!;
      if (param.type === "identifier") {
        names.push(param.text);
      } else if (param.type === "required_parameter" || param.type === "optional_parameter") {
        const pattern = param.childForFieldName("pattern");
        if (pattern) names.push(pattern.text);
      } else if (param.type === "assignment_pattern") {
        const left = param.childForFieldName("left");
        if (left) names.push(left.text);
      } else if (param.type === "rest_pattern") {
        names.push("..." + (param.namedChild(0)?.text ?? ""));
      } else {
        names.push(param.text);
      }
    }
    return names;
  }
}
