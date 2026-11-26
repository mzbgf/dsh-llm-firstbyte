import { test } from "node:test";
import assert from "node:assert/strict";

import { guardStream } from "../src/guard.js";
import { DEFAULTS } from "../src/config.js";

function harness(overrides = {}) {
  const rows = [];
  return {
    rows,
    ledger: { record: (route, sample) => rows.push({ route, ...sample }) },
    probe: { take: () => null, calls: [] },
    opts(extra = {}) {
      return {
        route: "p/m",
        budgetMs: 50,
        mode: "guard",
        ledger: this.ledger,
        probe: this.probe,
        cfg: DEFAULTS,
        t0: Date.now(),
        onDiag: () => {},
        ...overrides,
        ...extra,
      };
    },
  };
}

function hangingSource() {
  const state = { closed: false };
  const source = {
    [Symbol.asyncIterator]() {
      return {
        next: () => new Promise(() => {}),
        return: async () => {
          state.closed = true;
          return { done: true, value: undefined };
        },
      };
    },
  };
  return { source, state };
}

test("guard 模式：超预算吐 TIMEOUT 终止帧并关闭源头", async () => {
  const h = harness();
  const { source, state } = hangingSource();
  const out = [];
  for await (const chunk of guardStream(source, h.opts())) out.push(chunk);

  assert.equal(out.length, 1);
  assert.equal(out[0].type, "finish");
  assert.equal(out[0].reason.kind, "error");
  assert.equal(out[0].reason.failure.code, "TIMEOUT");
  assert.match(out[0].reason.failure.message, /first-byte budget 50ms/);
  assert.equal(state.closed, true, "应主动关闭上游迭代器");

  assert.equal(h.rows.length, 1);
  assert.equal(h.rows[0].outcome, "timeout");
  assert.equal(h.rows[0].ttft, null);
});

test("正常流：原样透传，记账为 finished", async () => {
  const h = harness({ mode: "diagnose" });
  async function* source() {
    yield { type: "text-delta", index: 0, text: "a" };
    yield { type: "usage", usage: { inputTokens: 10, cacheReadTokens: 990, outputTokens: 2, totalTokens: 1002 } };
    yield { type: "finish", reason: { kind: "stop" } };
  }
  const out = [];
  for await (const chunk of guardStream(source(), h.opts())) out.push(chunk);

  assert.deepEqual(
    out.map((c) => c.type),
    ["text-delta", "usage", "finish"],
  );
  assert.equal(h.rows.length, 1);
  assert.equal(h.rows[0].outcome, "finished");
  assert.equal(h.rows[0].cls, "hit", "usage 里 cacheRead 占绝大多数应记为 hit");
  assert.ok(h.rows[0].ttft >= 0);
});

test("diagnose 模式：越界只记账，不打断请求", async () => {
  const h = harness({ mode: "diagnose", budgetMs: 20 });
  const seen = [];
  async function* slowThenFast() {
    await new Promise((r) => setTimeout(r, 80));
    yield { type: "text-delta", index: 0, text: "late" };
    yield { type: "finish", reason: { kind: "stop" } };
  }
  const out = [];
  for await (const chunk of guardStream(slowThenFast(), h.opts({ onDiag: (d) => seen.push(d) }))) out.push(chunk);

  assert.equal(out.length, 2, "请求应继续完成，不被截断");
  assert.equal(out[1].type, "finish");
  assert.equal(seen.length, 1, "应触发一次诊断回调");
  assert.equal(seen[0].diag.kind, "unobserved");

  assert.equal(h.rows.length, 1);
  assert.equal(h.rows[0].outcome, "finished");
  assert.equal(h.rows[0].overBudget, true);
});

test("短回复不会被误判为缓冲", async () => {
  const h = harness({ mode: "diagnose", budgetMs: 5_000 });
  async function* source() {
    await new Promise((r) => setTimeout(r, 10));
    yield { type: "text-delta", index: 0, text: "x" };
  }
  for await (const _ of guardStream(source(), h.opts())) {
    /* 消费掉 */
  }
  assert.equal(h.rows[0].buffered, false);
  assert.equal(h.rows[0].outcome, "completed");
});
