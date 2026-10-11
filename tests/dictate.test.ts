import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { dictation, WIN_H, type DictateResult, type Helper } from "../src/server/dictate.ts";
import { DICTATION_FAILED, DICTATION_OFF, defaultsReader, startMacDictation } from "../electron/dictation.ts";

/** A stand-in for the hidden PowerShell: records what it's told, answers like the real one. */
class FakePowerShell extends EventEmitter implements Helper {
  exitCode: number | null = null;
  killed = false;
  lines: string[] = [];
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  /** How it answers a Win+H line: "pressed" (works), "silent" (hangs), or an error on stderr. */
  constructor(private answer: "pressed" | "silent" | "error" = "pressed") {
    super();
  }
  stdin = {
    write: (s: string) => {
      this.lines.push(s.trim());
      if (s.trim() !== WIN_H) return true;
      if (this.answer === "pressed") setImmediate(() => this.stdout.emit("data", "pressed\r\n"));
      if (this.answer === "error") setImmediate(() => this.stderr.emit("data", "Add-Type : Cannot add type. Compilation not allowed.\r\nmore"));
      return true;
    },
  };
  kill() {
    this.killed = true;
    this.exitCode = 1;
    this.emit("exit", 1);
    return true;
  }
}

const win = (make: () => FakePowerShell, timeoutMs = 200) => {
  const spawned: FakePowerShell[] = [];
  const d = dictation({
    platform: "win32",
    spawn: () => {
      const p = make();
      spawned.push(p);
      return p;
    },
    askApp: () => null,
    timeoutMs,
  });
  return { d, spawned };
};

test("Windows: the 🎤 presses Win+H through one hidden PowerShell, and hears back that it did", async () => {
  const { d, spawned } = win(() => new FakePowerShell());
  assert.equal(d.canDictate(), true);
  assert.deepEqual(await d.toggle(), { ok: true });
  assert.deepEqual(await d.toggle(), { ok: true }, "the second press (stop) works too");
  assert.equal(spawned.length, 1, "the same PowerShell is reused");
  const ps = spawned[0];
  assert.match(ps.lines[0], /^Add-Type .*keybd_event/, "it first loads the key-pressing code");
  assert.deepEqual(ps.lines.slice(1), [WIN_H, WIN_H]);
  // Win (0x5B) down, H (0x48) down, H up, Win up — in that order.
  const keys = [...WIN_H.matchAll(/keybd_event\((0x[0-9A-F]+),0,(\d)/g)].map((m) => `${m[1]}:${m[2]}`);
  assert.deepEqual(keys, ["0x5B:0", "0x48:0", "0x48:2", "0x5B:2"]);
  d.stop();
});

test("Windows: presses at once each get their own answer", async () => {
  const { d } = win(() => new FakePowerShell());
  const [a, b] = await Promise.all([d.toggle(), d.toggle()]);
  assert.deepEqual([a, b], [{ ok: true }, { ok: true }]);
  d.stop();
});

test("Windows: a PowerShell that can't press keys, or never answers, says how to start voice typing by hand", async () => {
  const broken = win(() => new FakePowerShell("error"));
  const r = await broken.d.toggle();
  assert.equal(r.ok, false);
  assert.match(r.error ?? "", /Win \+ H/);
  assert.match(broken.d.lastError, /Compilation not allowed/);
  broken.d.stop();

  const hung = win(() => new FakePowerShell("silent"), 30);
  const h = await hung.d.toggle();
  assert.equal(h.ok, false);
  assert.match(h.error ?? "", /Win \+ H/);
  hung.d.stop();
});

test("Windows: if PowerShell goes away, the waiting press is answered and the next press starts a new one", async () => {
  const { d, spawned } = win(() => new FakePowerShell("silent"), 5000);
  const waiting = d.toggle();
  spawned[0].kill();
  assert.equal((await waiting).ok, false);
  const again = d.toggle();
  assert.equal(spawned.length, 2);
  spawned[1].stdout.emit("data", "pressed\n");
  assert.deepEqual(await again, { ok: true });
  d.stop();
});

test("macOS: the server asks the desktop app, and falls back to how-to when it can't", async () => {
  let app: (() => Promise<DictateResult>) | null = null;
  const d = dictation({ platform: "darwin", spawn: () => assert.fail("no PowerShell on a Mac"), askApp: () => app, timeoutMs: 100 });
  assert.equal(d.canDictate(), false, "outside the desktop app there's nothing to ask");
  const none = await d.toggle();
  assert.equal(none.ok, false);
  assert.match(none.error ?? "", /Fn twice/);

  app = async () => ({ ok: true });
  assert.equal(d.canDictate(), true);
  assert.deepEqual(await d.toggle(), { ok: true });

  app = async () => ({ ok: false, error: DICTATION_OFF });
  assert.deepEqual(await d.toggle(), { ok: false, error: DICTATION_OFF });

  app = async () => {
    throw new Error("boom");
  };
  const thrown = await d.toggle();
  assert.equal(thrown.ok, false);
  assert.match(thrown.error ?? "", /Fn twice/);
});

test("elsewhere (Linux) the 🎤 doesn't press anything", async () => {
  const d = dictation({ platform: "linux", spawn: () => assert.fail("nothing to spawn"), askApp: () => async () => ({ ok: true }), timeoutMs: 100 });
  assert.equal(d.canDictate(), false);
  assert.equal((await d.toggle()).ok, false);
});

test("the Mac app starts dictation with Start Dictation, unless the Mac has dictation turned off", async () => {
  const sent: string[] = [];
  const mac = (setting: string | null | Error, send: (a: string) => void = (a) => sent.push(a)) =>
    startMacDictation({
      sendAction: send,
      readDefault: async (domain, key) => {
        assert.equal(domain, "com.apple.HIToolbox");
        assert.equal(key, "AppleDictationAutoEnable");
        if (setting instanceof Error) throw setting;
        return setting;
      },
    });

  assert.deepEqual(await mac("1"), { ok: true });
  assert.deepEqual(await mac(null), { ok: true }, "never set: try anyway");
  assert.deepEqual(await mac(new Error("defaults missing")), { ok: true }, "can't read the setting: try anyway");
  assert.deepEqual(sent, ["startDictation:", "startDictation:", "startDictation:"]);

  sent.length = 0;
  assert.deepEqual(await mac("0\n"), { ok: false, error: DICTATION_OFF });
  assert.deepEqual(sent, [], "dictation that's off isn't started");

  const failed = await mac("1", () => {
    throw new Error("no first responder");
  });
  assert.deepEqual(failed, { ok: false, error: DICTATION_FAILED });
  assert.match(DICTATION_FAILED, /Fn twice/);
});

test("the Mac's settings are read with `defaults read`, and a missing one is null", async () => {
  const calls: { cmd: string; args: string[] }[] = [];
  const read = defaultsReader((cmd, args, _opts, cb) => {
    calls.push({ cmd, args });
    if (args[2] === "Missing") cb(new Error("does not exist"), "");
    else cb(null, "1\n");
  });
  assert.equal(await read("com.apple.HIToolbox", "AppleDictationAutoEnable"), "1");
  assert.equal(await read("com.apple.HIToolbox", "Missing"), null);
  assert.deepEqual(calls[0], { cmd: "/usr/bin/defaults", args: ["read", "com.apple.HIToolbox", "AppleDictationAutoEnable"] });
  const throwing = defaultsReader(() => {
    throw new Error("ENOENT");
  });
  assert.equal(await throwing("a", "b"), null);
});

test("in the desktop app's background process, the server's dictation hook asks the app and hears its answer", async () => {
  const posted: { t?: string; id?: number }[] = [];
  const listeners: ((e: { data: unknown }) => void)[] = [];
  (process as unknown as { parentPort: unknown }).parentPort = {
    postMessage: (m: { t?: string; id?: number }) => {
      posted.push(m);
      // The app (electron/main.ts) answers a "dictate" with "dictated" and the same id.
      if (m.t === "dictate") setImmediate(() => listeners.forEach((f) => f({ data: { t: "dictated", id: m.id, ok: false, error: DICTATION_OFF } })));
    },
    on: (_e: string, f: (e: { data: unknown }) => void) => listeners.push(f),
  };
  try {
    const { connectToApp, inUtilityProcess } = await import("../src/server/parentPort.ts");
    assert.equal(inUtilityProcess, true);
    connectToApp(() => {});
    const hook = (globalThis as { __domainDictate?: () => Promise<DictateResult> }).__domainDictate;
    assert.ok(hook, "the hook dictate.ts uses on macOS is there");
    assert.deepEqual(await hook(), { ok: false, error: DICTATION_OFF });
    assert.equal(posted.filter((m) => m.t === "dictate").length, 1);
  } finally {
    delete (process as unknown as { parentPort?: unknown }).parentPort;
    delete (globalThis as { __domainDictate?: unknown }).__domainDictate;
  }
});
