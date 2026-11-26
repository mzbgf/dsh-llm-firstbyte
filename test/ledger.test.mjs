import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { RouteLedger, classifyUsage, isBuffered, percentile } from "../src/ledger.js";
import { budgetFor, routeKey, routeVerdict } from "../src/policy.js";
import { ConfigStore, DEFAULTS } from "../src/config.js";

test("percentile 用最近秩，不外推", () => {
  assert.equal(percentile([], 0.5), null);
  assert.equal(percentile([10], 0.99), 10);
  const xs = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
  assert.equal(percentile(xs, 0.5), 5);
  assert.equal(percentile(xs, 0.9), 9);
  assert.equal(percentile(xs, 0.995), 10);
});

test("缓存分类：命中率 ≥ 50% 为 hit，无字段为 unknown", () => {
  assert.equal(classifyUsage({ cacheReadTokens: 9000, inputTokens: 1000 }).cls, "hit");
  assert.equal(classifyUsage({ cacheReadTokens: 100, inputTokens: 9000 }).cls, "miss");
  assert.equal(classifyUsage({ inputTokens: 9000 }).cls, "unknown");
  assert.equal(classifyUsage(undefined).cls, "unknown");
});

test("缓冲判定排除短回复", () => {
  // 25s 的回复，首字节在 24s —— 缓冲
  assert.equal(isBuffered(24_000, 25_000), true);
  // 3s 的短回复，首字节在 2.4s —— 不算缓冲
  assert.equal(isBuffered(2_400, 3_000), false);
  // 正常的流式：首字节 5s、总 30s
  assert.equal(isBuffered(5_000, 30_000), false);
});

test("route 键与预算推导", () => {
  const cfg = { ...DEFAULTS, minSamples: 10 };
  assert.equal(routeKey({ provider: "p", model: "m" }), "p/m");
  assert.equal(routeKey({}), "unknown/unknown");

  const sparse = { n: 3, p995: 50_000, bufferedRatio: 0 };
  assert.equal(budgetFor(sparse, cfg), cfg.missMs, "样本不足时用保守默认值");

  const streaming = { n: 100, p995: 20_000, bufferedRatio: 0.05 };
  // 预算有 hit 下限：快 route 也不会低于 hitMs
  assert.equal(budgetFor(streaming, cfg), cfg.hitMs);
  assert.equal(routeVerdict(streaming, cfg), "流式");

  const buffered = { n: 100, p995: 30_000, bufferedRatio: 0.4 };
  assert.equal(budgetFor(buffered, cfg), cfg.bufferedMs, "缓冲型抬到 bufferedMs");
  assert.equal(routeVerdict(buffered, cfg), "缓冲型");
});

test("账本按 route 记账并给出分位与分类统计", () => {
  const dir = mkdtempSync(join(tmpdir(), "firstbyte-"));
  try {
    const ledger = new RouteLedger(dir, { window: 10 });
    for (let i = 0; i < 8; i += 1) {
      ledger.record("p/m", { ttft: (i + 1) * 1000, dur: 10_000, cls: i < 6 ? "hit" : "miss", buffered: false, outcome: "finished" });
    }
    const s = ledger.summary("p/m");
    assert.equal(s.n, 8);
    assert.equal(s.hitN, 6);
    assert.equal(s.missN, 2);
    assert.equal(s.p50, 4_000);
    assert.equal(s.max, 8_000);

    // 窗口裁剪：只留最近 10 条
    for (let i = 0; i < 20; i += 1) ledger.record("p/m", { ttft: 1, dur: 1, cls: "hit", buffered: false, outcome: "finished" });
    assert.equal(ledger.summary("p/m").n, 10);

    // 落盘可重载
    const reloaded = new RouteLedger(dir, { window: 10 });
    assert.equal(reloaded.summary("p/m").n, 10);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("配置补丁只接受已知键并做类型纠偏", () => {
  const dir = mkdtempSync(join(tmpdir(), "firstbyte-cfg-"));
  try {
    const store = new ConfigStore(dir, { hitMs: 31_000 });
    assert.equal(store.read().hitMs, 31_000);
    const next = store.patch({ mode: "guard", hitMs: "5000", nonsense: 1 });
    assert.equal(next.mode, "guard");
    assert.equal(next.hitMs, 5_000);
    assert.equal("nonsense" in next, false);
    assert.equal(store.read().mode, "guard");
    assert.equal(store.patch({ mode: "whatever" }).mode, "diagnose", "未知模式回落到 diagnose");
    // 小数型默认值不能被取整：bufferFloor 0.15 取整成 0 会让所有 route 直接判缓冲型
    assert.equal(store.read().bufferFloor, 0.15);
    assert.equal(store.patch({ bufferFloor: 0.3 }).bufferFloor, 0.3);
    assert.equal(store.patch({ bufferFloor: 0 }).bufferFloor, 0.3, "非正值不写入");
    // 盘上已有坏值 0 时也要回落，否则旧版本写坏的文件会把阈值钉在 0
    writeFileSync(join(dir, "config.json"), JSON.stringify({ bufferFloor: 0 }));
    assert.equal(store.read().bufferFloor, 0.15);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
