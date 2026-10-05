import { execFile } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Report } from "../shared/protocol.js";

/**
 * Pair workers: a builder and an auditor. When the builder says a task is
 * done (and it passes the check), the work goes to the auditor before it
 * comes to you: the office writes the builder's changes into the auditor's
 * own folder, the auditor reviews them and gives a verdict. Problems go back
 * to the builder; it fixes them and presents again; and round it goes —
 * until the auditor approves, or the rounds run out, or an audit takes too
 * long. Either way you then get one report, with what the audit found.
 */

export interface AuditOffice {
  workdir(deskId: string): string;
  hold(deskId: string, activity: string): void;
  amendReport(deskId: string, change: (r: Report) => Report): void;
  dismiss(deskId: string, message: string): void;
  review(deskId: string, approve: boolean, text?: string): boolean;
  /** Type an instruction into a worker's terminal. */
  instruct(deskId: string, text: string): void;
  isStaffed(deskId: string): boolean;
}

export interface AuditDeps {
  office: AuditOffice;
  /** Your branch (to diff the builder's work against), or null. */
  base(): string | null;
  /** A worker's name, for the briefs and the report. */
  nameOf(deskId: string): string;
  /** Hand the builder's report to you (into the line, announced). */
  release(deskId: string): void;
  /** Something worth a line in the history and a toast. */
  note(text: string, deskId: string, kind: "audit"): void;
  /** Simulated workers: act out the auditor's verdicts and the builder's fixes. */
  simulate?: { verdict(auditor: string, report: Report): void; recall(builder: string): void };
  /** How long an audit may take before the work comes to you anyway. */
  maxAuditMs?: number;
}

interface Pair {
  builder: string;
  auditor: string;
  task: string;
  max: number;
  round: number;
  phase: "building" | "auditing";
  since: number;
  /** What each round found. */
  findings: string[];
}

const DEFAULT_MAX_AUDIT_MS = 25 * 60_000;

function gitOut(cwd: string, args: string[]): Promise<string> {
  return new Promise((done) => execFile("git", args, { cwd, windowsHide: true, timeout: 15_000, maxBuffer: 8 * 1024 * 1024 }, (err, out) => done(err ? "" : String(out))));
}

export class Audits {
  private pairs = new Map<string, Pair>();

  constructor(private deps: AuditDeps) {}

  /** A task handed to a builder with an auditor. */
  start(builder: string, auditor: string, task: string, rounds: number): boolean {
    if (builder === auditor || !this.deps.office.isStaffed(auditor)) return false;
    this.pairs.set(builder, { builder, auditor, task, max: Math.max(1, rounds), round: 0, phase: "building", since: Date.now(), findings: [] });
    return true;
  }

  /** Who audits this builder, if anyone. */
  auditorOf(builder: string): string | null {
    return this.pairs.get(builder)?.auditor ?? null;
  }

  /** Whether this desk is auditing someone right now. */
  isAuditing(deskId: string): boolean {
    for (const p of this.pairs.values()) if (p.auditor === deskId && p.phase === "auditing") return true;
    return false;
  }

  /**
   * The builder's finished work (it passed the check): true if its auditor
   * takes it first (then it's held out of the line); false to let it through.
   */
  builderReady(builder: string, report: Report): boolean {
    const p = this.pairs.get(builder);
    if (!p || p.phase !== "building" || report.status !== "ready") return false;
    if (!this.deps.office.isStaffed(p.auditor)) {
      this.pairs.delete(builder);
      return false;
    }
    p.round++;
    p.phase = "auditing";
    p.since = Date.now();
    this.deps.office.hold(builder, `🔍 Being audited by ${this.deps.nameOf(p.auditor)} (round ${p.round} of ${p.max})`);
    void this.briefAuditor(p, report);
    return true;
  }

  /** An auditor's report: its verdict. True if it was one (then it isn't for you). */
  auditorReport(auditor: string, report: Report): boolean {
    const p = [...this.pairs.values()].find((x) => x.auditor === auditor && x.phase === "auditing");
    if (!p) return false;
    const approved = report.status === "ready";
    const issues = [report.summary, ...report.slides].filter(Boolean).join(" · ");
    this.deps.office.dismiss(auditor, approved ? "[Audit] Thanks — your approval is on its way to your manager. Carry on." : "[Audit] Thanks — the issues are with the builder now. You'll be asked again when it's fixed.");
    if (approved) {
      p.findings.push(`Round ${p.round}: approved — ${report.summary}`);
      this.finish(p, `🔍 Audited by ${this.deps.nameOf(p.auditor)}: approved after ${p.round} round${p.round === 1 ? "" : "s"}`);
      return true;
    }
    p.findings.push(`Round ${p.round}: ${issues}`);
    if (p.round >= p.max) {
      this.finish(p, `🔍 Audit stopped after ${p.max} round${p.max === 1 ? "" : "s"} — still open: ${issues}`);
      return true;
    }
    // Back to the builder with what the auditor found.
    p.phase = "building";
    p.since = Date.now();
    this.deps.note(`${this.deps.nameOf(p.auditor)} sent “${p.task}” back to ${this.deps.nameOf(p.builder)} (round ${p.round} of ${p.max})`, p.builder, "audit");
    this.deps.office.review(
      p.builder,
      false,
      `[Audit] ${this.deps.nameOf(p.auditor)} reviewed your work (round ${p.round} of ${p.max}) and found: ${issues}. Fix these, then present again (status "ready") — it goes back to them before your manager.`,
    );
    this.deps.simulate?.recall(p.builder);
    return true;
  }

  /** Audits that are taking too long come to you as they are. */
  tick(now = Date.now()): void {
    const limit = this.deps.maxAuditMs ?? DEFAULT_MAX_AUDIT_MS;
    for (const p of [...this.pairs.values()]) {
      if (p.phase === "auditing" && now - p.since > limit) {
        this.deps.office.instruct(p.auditor, "[Audit] Time's up on this audit — your manager will review it directly. Stop the audit and carry on.");
        this.finish(p, `🔍 Audit by ${this.deps.nameOf(p.auditor)} timed out in round ${p.round} — review it yourself`);
      }
    }
  }

  /** A worker left: its pairing ends (as builder or auditor). */
  forget(deskId: string): void {
    for (const [k, p] of this.pairs) if (p.builder === deskId || p.auditor === deskId) this.pairs.delete(k);
  }

  private finish(p: Pair, verdict: string): void {
    this.pairs.delete(p.builder);
    this.deps.office.amendReport(p.builder, (r) => ({ ...r, slides: [...r.slides, verdict, ...p.findings.slice(0, -1).map((f) => `Earlier — ${f}`)].slice(0, 14) }));
    this.deps.note(`${verdict.replace(/^🔍 /, "")} — “${p.task}”`, p.builder, "audit");
    this.deps.release(p.builder);
  }

  /** Write the builder's changes into the auditor's folder and ask for a verdict. */
  private async briefAuditor(p: Pair, report: Report): Promise<void> {
    const builderDir = this.deps.office.workdir(p.builder);
    const base = this.deps.base();
    const committed = base ? await gitOut(builderDir, ["diff", `${base}...HEAD`]) : "";
    const uncommitted = await gitOut(builderDir, ["diff", "HEAD"]);
    const diff = `${committed}\n${uncommitted}`.trim() || "(no changes in git — read the builder's summary)";
    const name = `audit-${p.builder}-round${p.round}.md`;
    const dir = join(this.deps.office.workdir(p.auditor), ".domain", "audit");
    try {
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        join(dir, name),
        `# Audit: ${p.task}\n\nBuilder: ${this.deps.nameOf(p.builder)} · round ${p.round} of ${p.max}\n\n## What they say they did\n\n${report.title}\n\n${report.summary}\n\n${report.slides.map((s) => `- ${s}`).join("\n")}\n\n${report.check ? `## The check\n\n\`${report.check.command}\` ${report.check.status}\n\n` : ""}${p.findings.length ? `## Earlier rounds\n\n${p.findings.map((f) => `- ${f}`).join("\n")}\n\n` : ""}## Their changes\n\n\`\`\`diff\n${diff.slice(0, 400_000)}\n\`\`\`\n`,
      );
    } catch {
      /* the brief still says what to do */
    }
    this.deps.office.instruct(
      p.auditor,
      `[Audit] ${this.deps.nameOf(p.builder)} says “${p.task}” is done (round ${p.round} of ${p.max}). Before your manager sees it, audit it: read .domain/audit/${name} (their summary and the full diff). Check it does what the task asks, that nothing is broken or missing, and that it's clean. Don't change their files. Then write a report to $DOMAIN_REPORT_FILE: status "ready" if it's good to go (summary: why), or status "blocked" if not — one concrete problem per slide. Only real problems: if it's good, approve it.`,
    );
    this.deps.simulate?.verdict(p.auditor, report);
  }
}
