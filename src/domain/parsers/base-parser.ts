import { createRequire } from "node:module";
import type TreeSitter from "tree-sitter";
import type {
  LanguageParser,
  ParsedFile,
  ImportsMap,
  SupportedLanguage,
} from "../types.js";

const require = createRequire(import.meta.url);
const Parser = require("tree-sitter") as typeof TreeSitter;

export abstract class BaseParser implements LanguageParser {
  protected parser: InstanceType<typeof Parser>;
  abstract readonly supportedExtensions: string[];
  abstract readonly languageName: string;

  constructor(language: unknown) {
    this.parser = new Parser();
    this.parser.setLanguage(language as TreeSitter.Language);
  }

  abstract parse(sourceCode: string, filePath: string, isDependency?: boolean): ParsedFile;
  abstract preScan(files: { filePath: string; sourceCode: string }[]): ImportsMap;

  /** Parse source text into a tree-sitter Tree. */
  protected parseSource(source: string): TreeSitter.Tree {
    return this.parser.parse(source);
  }

  /** Get text of a tree-sitter node. */
  protected getNodeText(node: TreeSitter.SyntaxNode): string {
    return node.text;
  }

  /** Get the text of a named field child, or undefined. */
  protected getFieldText(
    node: TreeSitter.SyntaxNode,
    fieldName: string,
  ): string | undefined {
    return node.childForFieldName(fieldName)?.text;
  }

  /**
   * Calculate cyclomatic complexity for a function body node.
   * Counts branching/logical constructs.
   */
  protected calculateCyclomaticComplexity(node: TreeSitter.SyntaxNode): number {
    let complexity = 1; // base path

    const branchTypes = new Set([
      "if_statement",
      "else_clause",
      "for_statement",
      "for_in_statement",
      "while_statement",
      "do_statement",
      "switch_case",
      "catch_clause",
      "ternary_expression",
      "conditional_expression",
      // PHP variants
      "foreach_statement",
      "elseif_clause",
    ]);

    const logicalOps = new Set(["&&", "||", "??", "and", "or"]);

    const walk = (n: TreeSitter.SyntaxNode) => {
      if (branchTypes.has(n.type)) {
        complexity++;
      }
      if (
        (n.type === "binary_expression" || n.type === "logical_expression") &&
        n.childForFieldName("operator")
      ) {
        const op = n.childForFieldName("operator")!.text;
        if (logicalOps.has(op)) complexity++;
      }
      for (let i = 0; i < n.childCount; i++) {
        walk(n.child(i)!);
      }
    };

    walk(node);
    return complexity;
  }

  /** Extract JSDoc / PHPDoc comment above a node. */
  protected extractDocstring(node: TreeSitter.SyntaxNode): string | undefined {
    const prev = node.previousNamedSibling;
    if (prev && prev.type === "comment") {
      const text = prev.text;
      if (text.startsWith("/**")) {
        return text;
      }
    }
    return undefined;
  }

  /** Find the enclosing function name for a node. */
  protected findEnclosingFunction(
    node: TreeSitter.SyntaxNode,
  ): { name: string; lineNumber: number } | undefined {
    let current = node.parent;
    while (current) {
      if (
        current.type === "function_declaration" ||
        current.type === "method_definition" ||
        current.type === "method_declaration" ||
        current.type === "function_definition"
      ) {
        const name = this.getFieldText(current, "name");
        if (name) {
          return { name, lineNumber: current.startPosition.row + 1 };
        }
      }
      // arrow function assigned to variable
      if (
        current.type === "variable_declarator" &&
        current.childForFieldName("value")?.type === "arrow_function"
      ) {
        const name = this.getFieldText(current, "name");
        if (name) {
          return { name, lineNumber: current.startPosition.row + 1 };
        }
      }
      current = current.parent;
    }
    return undefined;
  }

  /** Find the enclosing class name for a node. */
  protected findEnclosingClass(
    node: TreeSitter.SyntaxNode,
  ): string | undefined {
    let current = node.parent;
    while (current) {
      if (
        current.type === "class_declaration" ||
        current.type === "abstract_class_declaration" ||
        current.type === "class"
      ) {
        return this.getFieldText(current, "name");
      }
      current = current.parent;
    }
    return undefined;
  }

  /** Get language for a file extension. */
  protected langFromPath(_filePath: string): SupportedLanguage {
    return this.languageName as SupportedLanguage;
  }

  /** Create an empty ParsedFile. repoPath is set later by IndexCodeService. */
  protected emptyParsedFile(filePath: string): ParsedFile {
    return {
      path: filePath,
      repoPath: "",
      lang: this.langFromPath(filePath),
      functions: [],
      classes: [],
      imports: [],
      calls: [],
      variables: [],
    };
  }
}
