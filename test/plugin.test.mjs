import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// 用假的 ctx 跑一遍 apply：验证钩子签名、工具注册、请求路径都不炸。
// DSH_HOME 指到临时目录，避免污染真实账本。

test("apply 注册钩子与工具，并能跑通一次请求", async () => {
  const home = mkdtempSync(join(tmpdir(), "firstbyte-home-"));
  const previous = process.env.DSH_HOME;
  process.env.DSH_HOME = home;

  try {
    const mod = await import("../src/index.js");
    assert.equal(mod.name, "llm-firstbyte");
    assert.deepEqual(mod.inject, ["llm"]);

    const handlers = new Map();
    const tools = [];
    const ctx = {
      on(name, fn) {
        handlers.set(name, fn);
        return () => handlers.delete(name);
      },
      effect(fn) {
        return fn();
      },
      logger: { warn() {} },
      tools: {
        register(tool) {
          tools.push(tool);
          return () => {};
        },
      },
    };

    mod.apply(ctx, { mode: "diagnose", hitMs: 5_000 });

    assert.equal(tools.length, 3, "应注册三个工具");
    assert.deepEqual(tools.map((t) => t.name).sort(), [
      "llm_latency_policy",
      "llm_latency_report",
      "llm_latency_reset",
    ]);

    const hook = handlers.get("llm/stream");
    assert.equal(typeof hook, "function");

    async function* upstream() {
      yield { type: "text-delta", index: 0, text: "hi" };
      yield { type: "usage", usage: { inputTokens: 5, cacheReadTokens: 995, outputTokens: 1, totalTokens: 1001 } };
      yield { type: "finish", reason: { kind: "stop" } };
    }

    const stream = hook({ provider: "p", model: "m" }, () => upstream());
    const chunks = [];
    for await (const chunk of stream) chunks.push(chunk);
    assert.deepEqual(chunks.map((c) => c.type), ["text-delta", "usage", "finish"]);

    const report = await tools.find((t) => t.name === "llm_latency_report").execute({});
    assert.match(report.text, /p\/m/);
    assert.match(report.text, /样本 1 条/);

    const policy = await tools.find((t) => t.name === "llm_latency_policy").execute({ mode: "guard" });
    assert.equal(policy.config.mode, "guard");

    const reset = await tools.find((t) => t.name === "llm_latency_reset").execute({ confirm: false });
    assert.equal(reset.cleared, false);
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previous;
    rmSync(home, { recursive: true, force: true });
  }
});
