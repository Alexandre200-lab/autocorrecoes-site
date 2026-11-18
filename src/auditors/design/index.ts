import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { config, viewport } from "../../config/index.js";
import { resolveStorageState } from "../../config/project.js";
import { assertPublicUrl } from "../../security/network.js";
import { redactSecrets } from "../../security/redact.js";
import type { AuditOptions, RawSignal } from "../../shared/types.js";
import type { AuditContext, AuditResult, Auditor } from "../types.js";
import { mapImpactToSeverity } from "../types.js";

const WCAG_TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"];

interface DomInfo {
  title: string;
  lang: string;
  h1Count: number;
  brokenImages: string[];
  horizontalOverflow: boolean;
  scrollWidth: number;
  innerWidth: number;
}

export class DesignAuditor implements Auditor {
  readonly domain = "design" as const;

  async audit(target: string, options: AuditOptions, ctx: AuditContext): Promise<AuditResult> {
    const signals: RawSignal[] = [];
    const checksRun: string[] = [];
    const checksNotRun: string[] = [];
    let url: string;
    try {
      url = (await assertPublicUrl(target, options.allowPrivateHosts)).toString();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      signals.push({
        domain: "design",
        ruleId: "DESIGN_BLOCKED_HOST",
        title: "Host bloqueado pela proteção SSRF",
        message,
        severity: "P2",
        evidence: message,
        metadata: { error: true, requiresHuman: true },
      });
      return { signals, checksRun, checksNotRun, context: message };
    }
    const contextLines = [`Alvo: ${url}`, `TraceId: ${ctx.traceId}`];
    const screenshotDir = join(config.dataDir, "screenshots", ctx.runId);
    mkdirSync(screenshotDir, { recursive: true });

    let playwright: typeof import("playwright") | null = null;
    try {
      playwright = await import("playwright");
    } catch {
      checksNotRun.push("Playwright (pacote não instalado)");
      return {
        signals,
        checksRun,
        checksNotRun,
        context: `Dependência Playwright ausente. Instale com: npm install && npx playwright install chromium\n${contextLines.join("\n")}`,
      };
    }

    let browser: Awaited<ReturnType<typeof playwright.chromium.launch>>;
    try {
      browser = await playwright.chromium.launch({
        headless: config.PLAYWRIGHT_HEADLESS,
        args: ["--no-sandbox", "--disable-dev-shm-usage"],
      });
      checksRun.push("Chromium (Playwright)");
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      checksNotRun.push("Chromium (browser não instalado)");
      signals.push({
        domain: "design",
        ruleId: "BROWSER_UNAVAILABLE",
        title: "Navegador de auditoria indisponível",
        message: "Instale o Chromium com: npx playwright install chromium",
        severity: "P4",
        url,
        evidence: msg.slice(0, 500),
        metadata: { infrastructure: true },
      });
      return { signals, checksRun, checksNotRun, context: contextLines.join("\n") };
    }

    try {
      const AxeBuilder = (await import("@axe-core/playwright")).default;
      const viewports = [
        { name: "desktop", ...viewport() },
        { name: "mobile", width: 390, height: 844 },
      ];

      for (const vp of viewports) {
        // axe-core/playwright exige página criada via browser.newContext().
        const storageState = resolveStorageState(options.project ?? { auth: {} }, process.cwd());
        const browserContext = await browser.newContext({
          viewport: { width: vp.width, height: vp.height },
          ...(storageState ? { storageState } : {}),
          ...(options.project?.headers ? { extraHTTPHeaders: options.project.headers } : {}),
        });
        const page = await browserContext.newPage();
        if (!options.allowPrivateHosts) {
          // Bloqueia navegações e redirects para hosts internos (inclusive via JS).
          const hostCache = new Map<string, boolean>();
          await page.route("**/*", async (route) => {
            const target = route.request().url();
            if (!/^https?:\/\//i.test(target)) return route.abort();
            const host = new URL(target).hostname.replace(/^\[|\]$/g, "");
            let allowed = hostCache.get(host);
            if (allowed === undefined) {
              try {
                await assertPublicUrl(target, false);
                allowed = true;
              } catch {
                allowed = false;
              }
              hostCache.set(host, allowed);
            }
            return allowed ? route.continue() : route.abort();
          });
        }
        try {
          await page.goto(url, {
            waitUntil: "domcontentloaded",
            timeout: options.project?.timeoutMs ?? 30_000,
          });
          await page.waitForTimeout(700);

          const screenshot = join(screenshotDir, `${vp.name}.png`);
          await page.screenshot({ path: screenshot, fullPage: true });
          contextLines.push(`Screenshot ${vp.name}: ${screenshot}`);
          checksRun.push(`Screenshot ${vp.name} (${vp.width}x${vp.height})`);

          const results = await new AxeBuilder({ page }).withTags(WCAG_TAGS).analyze();
          checksRun.push(`axe-core WCAG A/AA 2.0/2.1/2.2 (${vp.name})`);
          for (const violation of results.violations) {
            const target = violation.nodes[0]?.target?.join(" ") ?? "n/a";
            signals.push({
              domain: "design",
              ruleId: `AXE_${violation.id.toUpperCase()}`,
              title: `${violation.help} (${vp.name})`,
              message: violation.description,
              severity: mapImpactToSeverity(violation.impact),
              url,
              selector: target,
              evidence: violation.nodes
                .slice(0, 3)
                .map((n) => `alvo=${n.target.join(" ")}\n${n.failureSummary ?? n.html}`)
                .join("\n---\n"),
              metadata: { wcagTags: violation.tags, impact: violation.impact, viewport: vp.name },
            });
          }
          // "incomplete" exige julgamento humano: nunca deve virar patch automático.
          for (const incomplete of results.incomplete.slice(0, 10)) {
            signals.push({
              domain: "design",
              ruleId: `AXE_INCOMPLETE_${incomplete.id.toUpperCase()}`,
              title: `Verificação manual necessária: ${incomplete.help} (${vp.name})`,
              message: "O axe não conseguiu determinarAutomaticamente passa/falha.",
              severity: "P4",
              url,
              selector: incomplete.nodes[0]?.target?.join(" ") ?? "n/a",
              evidence: incomplete.nodes
                .slice(0, 2)
                .map((n) => `${n.target.join(" ")}\n${n.any[0]?.message ?? n.html}`)
                .join("\n---\n"),
              metadata: { requiresHuman: true, viewport: vp.name },
            });
          }

          const dom = (await page.evaluate(() => ({
            title: document.title,
            lang: document.documentElement.lang,
            h1Count: document.querySelectorAll("h1").length,
            brokenImages: Array.from(document.images)
              .filter((img) => img.complete && img.naturalWidth === 0)
              .map((img) => img.currentSrc || img.src)
              .slice(0, 20),
            horizontalOverflow: document.documentElement.scrollWidth > window.innerWidth + 2,
            scrollWidth: document.documentElement.scrollWidth,
            innerWidth: window.innerWidth,
          }))) as DomInfo;

          checksRun.push(`Inspeção DOM (${vp.name})`);
          if (!dom.lang) {
            signals.push({
              domain: "design",
              ruleId: "MISSING_LANG",
              title: "Atributo lang ausente",
              message: "<html> não declara o idioma do documento.",
              severity: "P2",
              url,
              evidence: `<html> sem atributo lang. title="${dom.title}"`,
            });
          }
          if (dom.h1Count === 0) {
            signals.push({
              domain: "design",
              ruleId: "MISSING_H1",
              title: "Nenhum <h1> encontrado",
              message: "A página não possui título principal.",
              severity: "P3",
              url,
              evidence: `h1Count=0, title="${dom.title}"`,
            });
          }
          if (dom.brokenImages.length > 0) {
            signals.push({
              domain: "design",
              ruleId: "BROKEN_IMAGES",
              title: `${dom.brokenImages.length} imagem(ns) quebrada(s)`,
              message: "Imagens com naturalWidth=0 foram encontradas.",
              severity: "P3",
              url,
              evidence: dom.brokenImages.join("\n"),
              metadata: { images: dom.brokenImages },
            });
          }
          if (vp.name === "mobile" && dom.horizontalOverflow) {
            signals.push({
              domain: "design",
              ruleId: "MOBILE_HORIZONTAL_OVERFLOW",
              title: "Overflow horizontal no mobile",
              message: `scrollWidth=${dom.scrollWidth} > viewport=${dom.innerWidth}.`,
              severity: "P3",
              url,
              evidence: `scrollWidth=${dom.scrollWidth}, innerWidth=${dom.innerWidth}`,
            });
          }
          contextLines.push(
            redactSecrets(
              `DOM ${vp.name}: title="${dom.title}", lang="${dom.lang}", h1=${dom.h1Count}, ` +
                `brokenImages=${dom.brokenImages.length}, overflow=${dom.horizontalOverflow}`,
            ),
          );

          // Estado de interação: abre menu/sidebar quando presente.
          if (vp.name === "desktop") {
            const trigger = page.locator('[aria-expanded="false"], button:has-text("Menu"), button:has-text("menu")').first();
            if ((await trigger.count()) > 0) {
              try {
                await trigger.click({ timeout: 2500 });
                await page.waitForTimeout(300);
                const stateScreenshot = join(screenshotDir, "interaction.png");
                await page.screenshot({ path: stateScreenshot, fullPage: true });
                contextLines.push(`Screenshot estado interativo: ${stateScreenshot}`);
                checksRun.push("axe-core em estado interativo");
                const stateResults = await new AxeBuilder({ page }).withTags(WCAG_TAGS).analyze();
                for (const violation of stateResults.violations.slice(0, 10)) {
                  signals.push({
                    domain: "design",
                    ruleId: `AXE_STATE_${violation.id.toUpperCase()}`,
                    title: `${violation.help} (estado interativo)`,
                    message: violation.description,
                    severity: mapImpactToSeverity(violation.impact),
                    url,
                    selector: violation.nodes[0]?.target?.join(" ") ?? "n/a",
                    evidence: violation.nodes[0]?.failureSummary ?? violation.help,
                  });
                }
              } catch {
                // Estado interativo opcional.
              }
            }
          }
        } finally {
          await browserContext.close();
        }
      }

      // Lighthouse: tendência de score, nunca gate binário.
      try {
        const [lh, launcher] = await Promise.all([import("lighthouse"), import("chrome-launcher")]);
        const chrome = await launcher.launch({
          chromePath: playwright.chromium.executablePath(),
          chromeFlags: ["--headless=new", "--no-sandbox", "--disable-dev-shm-usage"],
        });
        try {
          const report = await lh.default(url, {
            port: chrome.port,
            output: "json",
            logLevel: "silent",
            onlyCategories: ["performance", "accessibility", "best-practices", "seo"],
          });
          const categories = (report?.lhr?.categories ?? {}) as Record<
            string,
            { score?: number | null }
          >;
          const scores = Object.fromEntries(
            Object.entries(categories).map(([key, value]) => [key, value.score ?? null]),
          );
          contextLines.push(`Lighthouse scores: ${JSON.stringify(scores)}`);
          checksRun.push("Lighthouse (scores informativos)");
        } finally {
          chrome.kill();
        }
      } catch (error) {
        checksNotRun.push(
          `Lighthouse indisponível: ${error instanceof Error ? error.message.slice(0, 120) : String(error)}`,
        );
      }
    } finally {
      await browser.close();
    }

    return { signals, checksRun, checksNotRun, context: contextLines.join("\n") };
  }
}

export const designAuditor = new DesignAuditor();
