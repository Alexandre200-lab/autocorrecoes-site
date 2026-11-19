import { parse } from "@babel/parser";
import postcss from "postcss";

/** Detecção semântica de "correções" que apenas escondem o problema. */

type AstNode = { type?: string; [key: string]: unknown };

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function staticString(node: unknown): string | null {
  if (!node || typeof node !== "object") return null;
  const value = node as AstNode;
  if (value.type === "StringLiteral") return String(value.value);
  if (value.type === "TemplateLiteral" && !value.expressions) {
    const quasis = value.quasis as Array<{ value?: { cooked?: string } }> | undefined;
    return quasis?.[0]?.value?.cooked ?? null;
  }
  return null;
}

function walk(node: unknown, visit: (node: AstNode) => void): void {
  if (!node || typeof node !== "object") return;
  const value = node as AstNode;
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

function propertyName(node: AstNode): string | undefined {
  const left = node.left as AstNode | undefined;
  if (left?.property && typeof left.property === "object") {
    const property = left.property as AstNode;
    if (typeof property.name === "string") return property.name;
  }
  if (typeof left?.name === "string") return left.name;
  const key = node.key as AstNode | undefined;
  if (typeof key?.name === "string") return key.name;
  return staticString(key) ?? undefined;
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
      reasons.push("CSS pointer-events:none desativa o elemento (AST)");
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
      const callee = node.callee as AstNode | undefined;
      const name =
        callee?.type === "Identifier"
          ? (callee.name as string)
          : callee?.property && typeof callee.property === "object"
            ? ((callee.property as AstNode).name as string)
            : undefined;
      const args = node.arguments as unknown[] | undefined;
      const argument = staticString(args?.[0]);

      if (name === "setAttribute" && ["aria-hidden", "hidden", "inert"].includes(argument ?? "")) {
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
      const key = propertyName(node);
      const right = node.right as AstNode | undefined;
      const valueNode = (right ?? node.value) as AstNode | undefined;
      const value = valueNode?.value;
      if (["ariaHidden", "hidden", "inert"].includes(String(key)) && value === true) {
        reasons.push(`${String(key)} definido como true (AST)`);
      }
    }
  });
  return unique(reasons);
}

export function detectSuppressionAst(content: string, format?: string): string[] {
  const looksCss =
    format === "css-rule" ||
    /\.css$/i.test(format ?? "") ||
    /[.#@]?[\w-]+\s*\{[^}]*:/.test(content);
  const reasons = looksCss ? detectCssSuppression(content) : detectJsSuppression(content);
  // Patches unified-diff/full-file podem conter CSS; executar ambos os parsers
  // evita o falso negativo que existia quando apenas o formato era considerado.
  if (format === "unified-diff" || format === "full-file") {
    return unique([...reasons, ...detectCssSuppression(content)]);
  }
  return reasons;
}
