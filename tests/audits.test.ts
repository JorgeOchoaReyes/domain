import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Audits, type AuditOffice } from "../src/server/audits.ts";
import type { Report } from "../src/shared/protocol.ts";

const done = (summary = "Added the form"): Report => ({ status: "ready", title: "Login form", summary, slides: ["Form", "Tests"], at: Date.now() });
const verdict = (ok: boolean, issues: string[] = []): Report => ({ status: ok ? "ready" : "blocked", title: "Audit", summary: ok ? "Good to go" : "Fix these", slides: issues, at: Date.now() });

function setup(rounds = 3, maxAuditMs?: number) {
  const dirs: Record<string, string> = { "desk-1": mkdtempSync(join(tmpdir(), "b-")), "desk-2": mkdtempSync(join(tmpdir(), "a-")) };
  const log: string[] = [];
  const reports: Record<string, Report> = { "desk-1": done() };
  const released: string[] = [];
  const office: AuditOffice = {
    workdir: (d) => dirs[d],
    hold: (d, a) => log.push(`hold ${d}: ${a}`),
    amendReport: (d, f) => (reports[d] = f(reports[d])),
    dismiss: (d) => log.push(`dismiss ${d}`),
    review: (d, approve, text) => (log.push(`review ${d} ${approve ? "approve" : "changes"}: ${text}`), true),
    instruct: (d, text) => log.push(`tell ${d}: ${text}`),
    isStaffed: () => true,
  };
  const audits = new Audits({ office, base: () => null, nameOf: (d) => (d === "desk-1" ? "Ada" : "Grace"), release: (d) => released.push(d), note: () => {}, maxAuditMs });
  audits.start("desk-1", "desk-2", "Login form", rounds);
  return { audits, log, reports, released, dirs };
}

test("finished work goes to the auditor first, with the builder's changes in the auditor's own folder", async () => {
  const { audits, log, released, dirs } = setup();
  assert.equal(audits.builderReady("desk-1", done()), true, "held for the audit");
  assert.match(log[0], /hold desk-1: 🔍 Being audited by Grace \(round 1 of 3\)/);
  assert.deepEqual(released, [], "not to you yet");
  await new Promise((r) => setTimeout(r, 300));
  const brief = log.find((l) => l.startsWith("tell desk-2"))!;
  assert.match(brief, /Ada says “Login form” is done \(round 1 of 3\)/);
  assert.match(brief, /\.domain\/audit\/audit-desk-1-round1\.md/);
  const file = join(dirs["desk-2"], ".domain", "audit", readdirSync(join(dirs["desk-2"], ".domain", "audit"))[0]);
  assert.match(readFileSync(file, "utf8"), /Added the form/);
});

test("issues go back to the builder; approval brings you one report with the audit's verdict", () => {
  const { audits, log, reports, released } = setup();
  audits.builderReady("desk-1", done());
  assert.equal(audits.auditorReport("desk-2", verdict(false, ["No empty-state", "Typo in the label"])), true, "the verdict isn't for you");
  assert.ok(log.some((l) => l.startsWith("review desk-1 changes:") && l.includes("No empty-state")), "the builder hears what to fix");
  assert.deepEqual(released, []);
  // Fixed, presented again: round 2, approved.
  assert.equal(audits.builderReady("desk-1", done("Fixed both")), true);
  assert.equal(audits.auditorReport("desk-2", verdict(true)), true);
  assert.deepEqual(released, ["desk-1"], "now it's yours");
  assert.ok(reports["desk-1"].slides.some((s) => /approved after 2 rounds/.test(s)));
  assert.ok(reports["desk-1"].slides.some((s) => /Earlier — Round 1:.*No empty-state/.test(s)), "with what was fixed along the way");
  assert.equal(audits.auditorOf("desk-1"), null, "the pairing for this task is over");
});

test("never endless: after the last round it comes to you with what's still open", () => {
  const { audits, released, reports } = setup(2);
  audits.builderReady("desk-1", done());
  audits.auditorReport("desk-2", verdict(false, ["Still broken"]));
  audits.builderReady("desk-1", done());
  audits.auditorReport("desk-2", verdict(false, ["Still broken"]));
  assert.deepEqual(released, ["desk-1"]);
  assert.ok(reports["desk-1"].slides.some((s) => /Audit stopped after 2 rounds — still open/.test(s)));
});

test("an audit that takes too long comes to you as it is", () => {
  const { audits, released, log } = setup(3, 1000);
  audits.builderReady("desk-1", done());
  audits.tick(Date.now() + 5000);
  assert.deepEqual(released, ["desk-1"]);
  assert.ok(log.some((l) => l.startsWith("tell desk-2") && /Time's up/.test(l)));
});

test("presenting again mid-audit keeps it with the auditor, and the rounds still count", () => {
  const { audits, released, reports } = setup(3);
  audits.builderReady("desk-1", done());
  assert.equal(audits.builderReady("desk-1", done("again")), true, "held, not to you");
  assert.deepEqual(released, []);
  audits.auditorReport("desk-2", verdict(false, ["One thing"]));
  audits.builderReady("desk-1", done("fixed"));
  audits.auditorReport("desk-2", verdict(true));
  assert.deepEqual(released, ["desk-1"]);
  assert.ok(reports["desk-1"].slides.some((s) => /approved after 2 rounds/.test(s)));
});
