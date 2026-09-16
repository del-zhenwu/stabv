// Control-plane stand-in for the ZCode CLI adapter: prints session-id JSON
// lines like the real `zcode --prompt --json`, then exits on its own.
const argv = process.argv.slice(2);
const resumed = argv.includes("--resume") || argv.includes("--continue");
const base = process.env.FAKE_ZCODE_SESSION ?? "sess_fake_1";
const drift = process.env.FAKE_ZCODE_SESSION_DRIFT;
const sid = resumed ? drift ?? base : base;
console.log(JSON.stringify({ sessionId: sid, event: "session_started" }));
setTimeout(() => {
  console.log(JSON.stringify({ sessionId: sid, event: "session_completed" }));
  process.exit(0);
}, 800);
