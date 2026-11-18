// Self-test the QQ UI send path on THIS machine.
// Useful right after moving to a new screen resolution / DPI / VM: it tells you
// whether the receipt-probe region is still sensitive enough.
//
//   node tools\selftest-send.mjs                # probe only: paste + clear, NEVER sends
//   node tools\selftest-send.mjs --send 张三    # actually send one message to 张三
//
// Probe-only output you want to see:
//   noise=0 span=772 (threshold 90)   <- span far above the threshold, region is fine
//   noise=74902 span=75060            <- the window was mid-repaint; run it again
//   span=0                            <- nothing landed in the input box
// `span` = pixels that changed between "empty input" and "text pasted", computed by
// image diff (not ink counts): QQ centers the placeholder but top-aligns typed text,
// so any fixed-height strip can miss the text entirely at some window sizes.
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.dirname(here);
process.chdir(root);

const args = process.argv.slice(2);
const sendIdx = args.indexOf("--send");
const probeOnly = sendIdx < 0;

if (probeOnly) {
    process.env.QQBOT_PROBE_ONLY = "1";
    console.log("[selftest] probe only - will paste and clear, nothing is sent");
} else {
    const target = args[sendIdx + 1];
    if (!target) {
        console.error("[selftest] usage: node tools\\selftest-send.mjs --send <chat name>");
        process.exit(2);
    }
    console.log(`[selftest] REAL send to "${target}"`);
}

const text = "自检文本 self-test " + new Date().toISOString().slice(11, 19);
const target = probeOnly ? "自检会话" : args[sendIdx + 1];

const t0 = Date.now();
try {
    const m = await import(pathToFileURL(path.join(root, "src", "send-ui.ts")).href);
    await m.send(target, text);
    console.log(`[selftest] OK in ${Date.now() - t0}ms`);
    process.exit(0);
} catch (e) {
    console.error(`[selftest] FAILED in ${Date.now() - t0}ms`);
    console.error(String(e?.message || e).slice(0, 500));
    process.exit(1);
}
