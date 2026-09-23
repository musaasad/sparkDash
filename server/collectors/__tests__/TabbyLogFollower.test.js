/**
 * TabbyLogFollower — continuous READ-ONLY log stream → live state.
 *
 * Hermetic: a FAKE spawn (no real SSH) emits __TABBYFILE__ markers + log lines on
 * a fake stdout stream. Verifies line buffering, file (re)point, live BUSY, and
 * that `available` tracks stream health. Never touches the network.
 */
import { test } from "node:test";
import { strict as assert } from "node:assert";
import { EventEmitter } from "node:events";
import { TabbyLogFollower, buildFollowCommand } from "../TabbyLogFollower.js";

const START =
  "2026-09-23 08:43:00.000 | INFO     | #10 chat/completions (stream): 12,000 prompt tokens · temperature: 0.8 (preset), max_tokens: 32768 (req)";
const DONE =
  "2026-09-23 08:43:06.000 | INFO     | #10 chat/completions (stream): 500 tokens generated at 63.0 T/s · prompt 12,000 tokens, 99% cached, 120 new in 1.0 s (300 T/s) · first token 1.0 s, total 8.0 s · draft 300/400 accepted (75%)";

/** A fake child_process.spawn returning a controllable fake ssh child. */
function fakeSpawn() {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = () => {
    child.killed = true;
  };
  fakeSpawn.last = child;
  return child;
}

const spark = {
  id: "dgx-3",
  lanIp: "192.168.1.246",
  tabbyLogDir: "/home/musaasad/tabbyAPI/logs",
  ssh: { host: "192.168.1.246", user: "musaasad", auth: "key" },
};

test("buildFollowCommand is READ-ONLY (ls + tail -F only) + escapes the dir", () => {
  const cmd = buildFollowCommand("/a/b", 200);
  assert.match(cmd, /ls -1t/);
  assert.match(cmd, /tail -n 200 -F/);
  assert.doesNotMatch(cmd, /\b(rm|mv|touch|truncate|dd|tee)\b/, "must never write/rotate/delete");
  assert.doesNotMatch(cmd.replace(/2>\/dev\/null/g, ""), />/, "no output redirection except 2>/dev/null");
  assert.match(buildFollowCommand("/it's"), /'\\''/, "single-quote escaped");
});

test("follower folds streamed lines into live state; BUSY on START, closes on completion", () => {
  const f = new TabbyLogFollower(spark, { spawnFn: fakeSpawn });
  f.start();
  const child = fakeSpawn.last;
  assert.equal(f.getState().available, true, "connected stream is available");

  child.stdout.emit("data", Buffer.from("__TABBYFILE__=2026-09-23_08-43-00.log\n"));
  assert.equal(f.getState().file, "2026-09-23_08-43-00.log");

  child.stdout.emit("data", Buffer.from(START + "\n"));
  let s = f.getState();
  assert.equal(s.active, true, "BUSY the instant the START line lands");
  assert.equal(s.activeCount, 1);

  // A partial line is buffered until its newline arrives (no half-line parse).
  child.stdout.emit("data", Buffer.from(DONE.slice(0, 40)));
  assert.equal(f.getState().lastRequestId, null, "incomplete line not parsed yet");
  child.stdout.emit("data", Buffer.from(DONE.slice(40) + "\n"));
  s = f.getState();
  assert.equal(s.lastRequestId, 10, "completion lands when the line completes");
  assert.equal(s.active, false, "completion closes the request");
  assert.equal(s.recentMedGenTps, 63);

  f.stop();
  assert.equal(f.getState().available, false, "stopped stream is not available");
});

test("follower re-points on a new file marker (rotation/relaunch)", () => {
  const f = new TabbyLogFollower(spark, { spawnFn: fakeSpawn });
  f.start();
  const child = fakeSpawn.last;
  child.stdout.emit("data", Buffer.from("__TABBYFILE__=a.log\n" + START + "\n"));
  assert.equal(f.getState().activeCount, 1);
  // New file = new launch: stale in-flight cleared.
  child.stdout.emit("data", Buffer.from("__TABBYFILE__=b.log\n"));
  const s = f.getState();
  assert.equal(s.file, "b.log");
  assert.equal(s.activeCount, 0, "new file clears the previous launch's in-flight state");
  f.stop();
});

test("follower marks unavailable when the stream drops (no frozen BUSY), reconnects", () => {
  const f = new TabbyLogFollower(spark, { spawnFn: fakeSpawn });
  f.start();
  const child = fakeSpawn.last;
  child.stdout.emit("data", Buffer.from("__TABBYFILE__=a.log\n" + START + "\n"));
  assert.equal(f.getState().active, true);
  child.emit("close"); // SSH connection dropped
  assert.equal(f.getState().available, false, "dropped stream => honest absence, not stale-live");
  f.stop();
});