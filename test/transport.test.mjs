import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";

import { diagnoseSilence, installProbe, withRequestContext } from "../src/transport.js";

function listen(handler) {
  const server = createServer(handler);
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolve({ server, url: `http://127.0.0.1:${port}` });
    });
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test("探针分开记录「响应头」与「首字节」，且不破坏流", async () => {
  const { server, url } = await listen(async (req, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    // 头立刻发（写到 socket），第一个字节 200ms 后才来 —— 模拟「已送达但在缓冲」
    res.flushHeaders();
    await sleep(200);
    res.write("data: first\n\n");
    await sleep(100);
    res.write("data: second\n\n");
    res.end();
  });

  const probe = installProbe();
  assert.ok(probe, "探针应能装上");

  try {
    const t0 = Date.now();
    const response = await withRequestContext({ route: "p/m" }, () => fetch(url));
    assert.equal(response.status, 200);

    const body = await response.text();
    assert.match(body, /first/);
    assert.match(body, /second/);

    const record = probe.take("p/m", t0);
    assert.ok(record, "应能认领到本次 fetch");
    assert.equal(record.attribution, "als");

    const headersMs = record.headersAt - record.t0;
    const firstBodyMs = record.firstBodyAt - record.t0;
    assert.ok(headersMs < 150, `响应头应早于 150ms，实际 ${headersMs}ms`);
    assert.ok(firstBodyMs >= 150, `首字节应晚于 150ms，实际 ${firstBodyMs}ms`);

    const diag = diagnoseSilence({ ...record, firstBodyAt: null }, record.t0, 60_000);
    assert.equal(diag.kind, "headers-only");
    assert.match(diag.text, /缓冲/);
  } finally {
    probe.uninstall?.();
    server.close();
  }
});

test("没有响应头时诊断为未送达", async () => {
  const { server, url } = await listen(async (req, res) => {
    // 故意不回任何东西，1.5s 后断开
    await sleep(1500);
    res.destroy();
  });

  const probe = installProbe();
  try {
    const t0 = Date.now();
    const pending = withRequestContext({ route: "slow/m" }, () => fetch(url)).catch(() => null);
    await sleep(300);
    const record = probe.take("slow/m", t0) ?? probe.calls.at(-1);
    const diag = diagnoseSilence({ ...record, headersAt: null }, t0, 300);
    assert.equal(diag.kind, "not-delivered");
    await pending;
  } finally {
    probe.uninstall?.();
    server.close();
  }
});

test("探针不可见时诊断为 unobserved", () => {
  const diag = diagnoseSilence(null, Date.now(), 30_000);
  assert.equal(diag.kind, "unobserved");
});

test("非 LLM 流量不被包装，保持原样", async () => {
  const { server, url } = await listen((req, res) => {
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("plain-body");
  });
  const probe = installProbe();
  try {
    const response = await fetch(url);
    const record = probe.calls.at(-1);
    assert.equal(record.headersAt > 0, true, "仍应记账头时刻");
    assert.equal(record.wrapped, undefined, "不应包装无关流量");
    assert.equal(await response.text(), "plain-body");
  } finally {
    probe.uninstall?.();
    server.close();
  }
});
