import { parse } from "@babel/parser";
import postcss from "postcss";

/** Detecção semântica de "correções" que apenas escondem o problema. */

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function staticString(node: any): string | null {
  if (!node) return null;
  if (node.type === "StringLiteral") return String(node.value);
  if (node.type === "TemplateLiteral" && node.expressions?.length === 0) {
    return node.quasis?.[0]?.value?.cooked ?? null;
  }
  return null;
}

function walk(node: unknown, visit: (node: any) => void): void {
  if (!node || typeof node !== "object") return;
  const value = node as Record<string, unknown>;
  if (typeof value.type === "string") visit(value);
  for (const key of Object.keys(value)) {
    if (key === "loc" || key === "start" || key === "end" || key === "extra") continue;
    const child = value[key];
    if (Array.isArray(child)) {
      for (const item of child) walk(item, visit);
    } else if (child && typeof child === "object") {
      walk(child, visit);
    }
  }
}

export function detectCssSuppression(content: string): string[] {
  const reasons: string[] = [];
  let root;
  try {
    root = postcss.parse(content);
  } catch {
    return reasons; // CSS inválido é tratado em outra camada
  }
  root.walkDecls((declaration) => {
    const property = declaration.prop.toLowerCase();
    const value = declaration.value.toLowerCase().trim();
    if (property === "display" && /\bnone\b/.test(value)) {
      reasons.push("CSS display:none esconde o elemento (AST)");
    }
    if (property === "visibility" && /hidden|collapse/.test(value)) {
      reasons.push("CSS visibility esconde o elemento (AST)");
    }
    if (property === "opacity" && /^0(?:\.0*)?$/.test(value)) {
      reasons.push("CSS opacity:0 esconde o elemento (AST)");
    }
    if (property === "pointer-events" && /\bnone\b/.test(value)) {
      reasons.push("CSS pointer-events:none desativa a interação (AST)");
    }
  });
  return unique(reasons);
}

export function detectJsSuppression(content: string): string[] {
  const reasons: string[] = [];
  let ast;
  try {
    ast = parse(content, {
      sourceType: "module",
      errorRecovery: true,
      plugins: ["typescript", "jsx", "decorators-legacy"],
    });
  } catch {
    return reasons;
  }

  walk(ast, (node) => {
    if (node.type === "CallExpression") {
      const callee = node.callee;
      const name =
        callee?.type === "Identifier"
          ? callee.name
          : callee?.property?.type === "Identifier"
            ? callee.property.name
            : undefined;
      const argument = staticString(node.arguments?.[0]);

      if (
        name === "setAttribute" &&
        ["aria-hidden", "hidden", "inert"].includes(argument ?? "")
      ) {
        reasons.push(`${argument} aplicado via setAttribute (AST)`);
      }
      if (name === "disableRules" || name === "disableRule") {
        reasons.push("regra de auditoria desligada (AST)");
      }
      if (["skip", "xit", "xdescribe", "xtest", "only"].includes(name ?? "")) {
        reasons.push(`teste ${name} desligado/focado (AST)`);
      }
    }

    if (node.type === "AssignmentExpression" || node.type === "ObjectProperty") {
      const key =
        node.left?.property?.name ??
        node.left?.name ??
        node.key?.name ??
        staticString(node.key);
      const value = node.right?.value ?? node.value?.value;
      if (["ariaHidden", "hidden", "inert"].includes(String(key)) && value === true) {
        reasons.push(`${String(key)} definido como true (AST)`);
      }
    }
  });
  return unique(reasons);
}

export function detectSuppressionAst(content: string, format?: string): string[] {
  const isCss = format === "css-rule" || /\.css$/i.test(format ?? "");
  return isCss ? detectCssSuppression(content) : detectJsSuppression(content);
}
