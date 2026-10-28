import { parse } from "@babel/parser";
import { DEFAULT_APP } from "./names.ts";

/** Where a recipe breaks the rule of K-802, with its line and column. */
export class RecipeError extends Error {
  override readonly name = "RecipeError";
}

type Node = { type: string; loc?: { start: { line: number; column: number } } | null } & Record<
  string,
  unknown
>;

const at = (node: Node) =>
  node.loc ? `line ${node.loc.start.line}, column ${node.loc.start.column + 1}` : "somewhere";

/** Turns a literal node into JSON. Anything that computes is an error (K-802). */
function literal(node: Node): unknown {
  switch (node.type) {
    case "StringLiteral":
    case "NumericLiteral":
    case "BooleanLiteral":
      return node["value"];
    case "NullLiteral":
      return null;
    case "TemplateLiteral": {
      const expressions = node["expressions"] as Array<Node>;
      const quasis = node["quasis"] as Array<{ value: { cooked: string } }>;
      if (expressions.length > 0)
        throw new RecipeError(`A template string with \${...} computes (${at(node)}).`);
      return quasis.map((part) => part.value.cooked).join("");
    }
    case "ArrayExpression":
      return (node["elements"] as Array<Node | null>).map((element) => {
        if (!element || element.type === "SpreadElement")
          throw new RecipeError(`A list may hold only values (${at(node)}).`);
        return literal(element);
      });
    case "ObjectExpression": {
      const result: Record<string, unknown> = {};
      for (const property of node["properties"] as Array<Node>) {
        if (property.type !== "ObjectProperty" || property["computed"] || property["shorthand"]) {
          throw new RecipeError(`An object may hold only plain "key: value" pairs (${at(property)}).`);
        }
        const key = property["key"] as Node;
        const name =
          key.type === "Identifier" ? key["name"] : key.type === "StringLiteral" ? key["value"] : null;
        if (typeof name !== "string") throw new RecipeError(`A key must be a name or a string (${at(key)}).`);
        result[name] = literal(property["value"] as Node);
      }
      return result;
    }
    case "TSAsExpression":
    case "TSSatisfiesExpression":
      return literal(node["expression"] as Node);
    default:
      throw new RecipeError(`A recipe holds values only; ${node.type} computes (${at(node)}).`);
  }
}

/**
 * K-802, K-803, K-804: reads `kitshn.config.ts` without running it, as the apps by key. The file may import only
 * `defineApp` and `defineApps` from "kitshn" and export one `defineApp({...})` call, which is the app `app`, or
 * one `defineApps({...})` call, with a literal object.
 */
export function readApps(source: string): unknown {
  let program: Node;
  try {
    program = parse(source, { sourceType: "module", plugins: ["typescript"] }).program as unknown as Node;
  } catch (error) {
    throw new RecipeError(`kitshn.config.ts is not valid TypeScript: ${String(error)}`);
  }
  let apps: unknown;
  let found = false;
  for (const statement of program["body"] as Array<Node>) {
    if (statement.type === "ImportDeclaration") {
      const from = (statement["source"] as Node)["value"];
      const names = (statement["specifiers"] as Array<Node>).map(
        (item) => (item["imported"] as Node | undefined)?.["name"],
      );
      if (from !== "kitshn" || names.some((name) => name !== "defineApp" && name !== "defineApps")) {
        throw new RecipeError(
          `A recipe imports only defineApp and defineApps from "kitshn" (${at(statement)}).`,
        );
      }
      continue;
    }
    if (statement.type === "ExportDefaultDeclaration") {
      const call = statement["declaration"] as Node;
      const callee = call["callee"] as Node | undefined;
      const args = (call["arguments"] as Array<Node> | undefined) ?? [];
      if (
        call.type !== "CallExpression" ||
        callee?.type !== "Identifier" ||
        (callee["name"] !== "defineApp" && callee["name"] !== "defineApps") ||
        args.length !== 1
      ) {
        throw new RecipeError(
          `The default export must be defineApp({...}) or defineApps({...}) (${at(statement)}).`,
        );
      }
      const [argument] = args;
      if (argument?.type !== "ObjectExpression")
        throw new RecipeError(`${String(callee["name"])} takes one object literal (${at(call)}).`);
      apps = callee["name"] === "defineApp" ? { [DEFAULT_APP]: literal(argument) } : literal(argument);
      found = true;
      continue;
    }
    throw new RecipeError(
      `A recipe has only the import and the default export; ${statement.type} is not allowed (${at(statement)}).`,
    );
  }
  if (!found)
    throw new RecipeError(
      "kitshn.config.ts has no `export default defineApp({...})` or `defineApps({...})`.",
    );
  return apps;
}
