import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import YAML from "yaml";
import { z } from "zod";
import type { Severity } from "../shared/types.js";

/** Configuração opcional por projeto: .autocorrecoes.yml na raiz do alvo. */

const RuleActionSchema = z.enum(["off", "P1", "P2", "P3", "P4"]);

export const ProjectConfigSchema = z.object({
  version: z.number().int().positive().default(1),
  ignore: z.array(z.string()).default([]),
  domains: z.array(z.enum(["design", "backend", "code"])).optional(),
  rules: z.record(z.string(), RuleActionSchema).default({}),
  headers: z.record(z.string(), z.string()).default({}),
  auth: z
    .object({
      /** Caminho para um storageState.json gerado por `playwright codegen --save-storage`. */
      storageState: z.string().optional(),
    })
    .default({}),
  baseline: z
    .object({
      fingerprints: z.array(z.string()).default([]),
    })
    .default({ fingerprints: [] }),
  maxPages: z.number().int().positive().optional(),
  timeoutMs: z.number().int().positive().optional(),
  schedule: z
    .object({
      enabled: z.boolean().default(false),
      everyMinutes: z.number().int().positive().default(60),
    })
    .default({ enabled: false, everyMinutes: 60 }),
});

export type ProjectConfig = z.infer<typeof ProjectConfigSchema>;
export type RuleAction = z.infer<typeof RuleActionSchema>;

const DEFAULT_CONFIG: ProjectConfig = ProjectConfigSchema.parse({});

export function findProjectConfigFile(root: string): string | null {
  for (const name of [".autocorrecoes.yml", ".autocorrecoes.yaml"]) {
    const candidate = resolve(root, name);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

export function loadProjectConfig(root: string): ProjectConfig {
  const file = findProjectConfigFile(root);
  if (!file) return DEFAULT_CONFIG;
  const parsed = ProjectConfigSchema.safeParse(YAML.parse(readFileSync(file, "utf8")));
  if (!parsed.success) {
    throw new Error(`Configuração de projeto inválida em ${file}: ${z.prettifyError(parsed.error)}`);
  }
  return parsed.data;
}

/** Mescla fingerprints no baseline do .autocorrecoes.yml do alvo. */
export function addBaselineFingerprints(
  root: string,
  fingerprints: string[],
  explicitFile?: string,
): {
  file: string;
  total: number;
} {
  const file = explicitFile ?? findProjectConfigFile(root) ?? resolve(root, ".autocorrecoes.yml");
  const existing = existsSync(file)
    ? (YAML.parse(readFileSync(file, "utf8")) as Record<string, unknown>)
    : {};
  const baseline = (existing.baseline ?? {}) as { fingerprints?: string[] };
  const merged = [...new Set([...(baseline.fingerprints ?? []), ...fingerprints])];
  existing.baseline = { ...baseline, fingerprints: merged };
  writeFileSync(file, YAML.stringify(existing), "utf8");
  return { file, total: merged.length };
}

/** Lê as fingerprints atuais de um arquivo de configuração arbitrário. */
export function readBaselineFingerprints(file: string): string[] {
  if (!existsSync(file)) return [];
  try {
    const parsed = YAML.parse(readFileSync(file, "utf8")) as
      | { baseline?: { fingerprints?: string[] } }
      | null;
    const values = parsed?.baseline?.fingerprints;
    return Array.isArray(values) ? values.filter((v): v is string => typeof v === "string") : [];
  } catch {
    return [];
  }
}

export function resolveStorageState(
  config: Pick<ProjectConfig, "auth">,
  root: string,
): string | undefined {
  const value = config.auth.storageState;
  if (!value) return undefined;
  const path = isAbsolute(value) ? value : resolve(root, value);
  return existsSync(path) ? path : undefined;
}

/** Glob simples com suporte a * e **, sem dependência externa. */
export function globToRegExp(pattern: string): RegExp {
  let source = "";
  for (let i = 0; i < pattern.length; i += 1) {
    const char = pattern[i];
    if (char === "*") {
      if (pattern[i + 1] === "*") {
        i += 1;
        if (pattern[i + 1] === "/") {
          i += 1;
          source += "(?:.*/)?";
        } else {
          source += ".*";
        }
      } else {
        source += "[^/]*";
      }
    } else if (char === "?") {
      source += "[^/]";
    } else {
      source += char.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    }
  }
  return new RegExp(`^${source}$`);
}

export function isIgnored(path: string, patterns: string[]): boolean {
  const normalized = path.replace(/\\/g, "/");
  return patterns.some((pattern) => globToRegExp(pattern).test(normalized));
}

export function ruleAction(config: ProjectConfig, ruleId: string): RuleAction | undefined {
  return config.rules[ruleId];
}

export function applySeverityOverride(severity: Severity, ruleId: string, config: ProjectConfig): Severity {
  const action = ruleAction(config, ruleId);
  return action && action !== "off" ? action : severity;
}
