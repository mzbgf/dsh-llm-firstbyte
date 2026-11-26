// 给 agent 的三个工具：看账、改策略、清账。
// 工具不参与请求路径，只读写 ledger/config，因此出错也不会影响 LLM 调用。

import { budgetFor, routeNote, routeVerdict } from "./policy.js";

const MAX_RENDER = 20_000;

function text(value) {
  const body = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  return [{ type: "text", text: body.length > MAX_RENDER ? `${body.slice(0, MAX_RENDER)}\n…（已截断）` : body }];
}

function sec(ms) {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return "—";
  return `${(ms / 1000).toFixed(1)}s`;
}

function pct(x) {
  return `${(x * 100).toFixed(0)}%`;
}

function table(rows, cfg) {
  const head = [
    "| route | n | 命中/未命中 | p50 | p90 | p99 | p99.5 | max | 缓冲占比 | 判定 | 预算 |",
    "|---|---|---|---|---|---|---|---|---|---|---|",
  ];
  const body = rows.map((s) => {
    const budget = budgetFor(s, cfg);
    return `| ${s.route} | ${s.n} | ${s.hitN}/${s.missN} | ${sec(s.p50)} | ${sec(s.p90)} | ${sec(s.p99)} | ${sec(s.p995)} | ${sec(s.max)} | ${pct(s.bufferedRatio)} | ${routeVerdict(s, cfg)} | ${sec(budget)} |`;
  });
  return [...head, ...body].join("\n");
}

export function registerTools(ctx, { store, ledger, probe }) {
  const disposers = [];

  const add = (tool) => {
    try {
      disposers.push(ctx.effect(() => ctx.tools.register(tool), `llm-firstbyte: ${tool.name}`));
    } catch {
      /* 没有 tools 服务的 profile 直接跳过 */
    }
  };

  add({
    name: "llm_latency_report",
    description:
      "看各个 provider/model 的首字节时延账：命中/未命中分列、缓冲型判定、当前预算，以及最近的越界诊断。用于判断某条 route 的沉默到底是「没发出去」还是「上游缓冲」。",
    parameters: {
      type: "object",
      properties: {
        route: { type: "string", description: "只看某条 route（provider/model）；省略看全部" },
        limit: { type: "number", description: "最多列几条 route，默认 20" },
        recent: { type: "number", description: "额外列出最近 N 次请求的诊断，默认 0" },
      },
      required: [],
      additionalProperties: false,
    },
    output: { schema: { type: "object" }, render: (_args, value) => text(value.text) },
    execute: async (args = {}) => {
      const cfg = store.read();
      const limit = Math.max(1, Math.min(100, Number(args.limit) || 20));
      const names = args.route ? [String(args.route)] : ledger.routes();
      if (names.length === 0) {
        return {
          text: "还没有样本。插件装好后每个 LLM 请求都会记一条；先跑几轮再看。",
          routes: [],
        };
      }
      const summaries = names.map((name) => ledger.summary(name)).sort((a, b) => b.n - a.n).slice(0, limit);
      const lines = [
        `样本 ${summaries.reduce((n, s) => n + s.n, 0)} 条，route ${names.length} 条；模式 ${cfg.mode}，样本门槛 ${cfg.minSamples}。`,
        "",
        table(summaries, cfg),
        "",
        "注：`缓冲占比` = 首字节落在回复最后 20% 的请求比例（只看 >10s 的回复）。它高的 route，首字节阈值没有语义。",
      ];

      const recentN = Math.max(0, Math.min(50, Number(args.recent) || 0));
      if (recentN > 0) {
        lines.push("", `最近 ${recentN} 次（含诊断）：`);
        const rows = [];
        for (const name of names) {
          const summary = ledger.summary(name);
          for (const item of summary.recent ?? []) rows.push({ name, item });
        }
        rows.sort((a, b) => (b.item.at ?? 0) - (a.item.at ?? 0));
        for (const { name, item } of rows.slice(0, recentN)) {
          const when = new Date(item.at).toISOString().replace("T", " ").slice(0, 19);
          lines.push(
            `- ${when} ${name} 首字节 ${sec(item.ttft)} 总 ${sec(item.dur)} ${item.cls} ${item.outcome}` +
              `${item.overBudget ? ` 越界(${item.diagnosis ?? "?"})` : ""}${item.headersMs !== null ? ` 头 ${sec(item.headersMs)}` : ""}`,
          );
        }
      }

      lines.push("", "建议：");
      for (const s of summaries) lines.push(`- ${s.route}：${routeNote(s, cfg)}`);

      const transport = probe
        ? `传输层探针已装（已观测 ${probe.calls.length} 次 fetch）`
        : "传输层探针不可用（适配器可能不走全局 fetch），诊断为「unobserved」";
      lines.push("", transport);

      return { text: lines.join("\n"), routes: summaries.map(({ recent, ...rest }) => rest) };
    },
  });

  add({
    name: "llm_latency_policy",
    description:
      "读或改首字节策略：mode（diagnose 只记录 / guard 超预算即失败重试）、hitMs、missMs、bufferedMs、capMs、minSamples、bufferFloor。只给要改的字段，其余不动。",
    parameters: {
      type: "object",
      properties: {
        mode: { type: "string", enum: ["diagnose", "guard"] },
        enabled: { type: "boolean" },
        hitMs: { type: "number" },
        missMs: { type: "number" },
        bufferedMs: { type: "number" },
        capMs: { type: "number" },
        minSamples: { type: "number" },
        bufferFloor: { type: "number" },
        window: { type: "number" },
      },
      required: [],
      additionalProperties: false,
    },
    output: { schema: { type: "object" }, render: (_args, value) => text(value.text) },
    execute: async (args = {}) => {
      const patch = {};
      for (const key of ["mode", "enabled", "hitMs", "missMs", "bufferedMs", "capMs", "minSamples", "bufferFloor", "window"]) {
        if (args[key] !== undefined) patch[key] = args[key];
      }
      const cfg = Object.keys(patch).length > 0 ? store.patch(patch) : store.read();
      return {
        text: [
          "当前策略：",
          `- 模式：${cfg.mode}（diagnose 只记录；guard 超预算即发 TIMEOUT 终止帧交给重试）`,
          `- 命中 ${sec(cfg.hitMs)} / 未命中 ${sec(cfg.missMs)} / 缓冲型 ${sec(cfg.bufferedMs)} / 上限 ${sec(cfg.capMs)}`,
          `- 学习门槛 ${cfg.minSamples} 条；缓冲判定阈值 ${pct(cfg.bufferFloor)}`,
          "",
          "修改立即生效，不需要重启。",
        ].join("\n"),
        config: cfg,
      };
    },
  });

  add({
    name: "llm_latency_reset",
    description: "清空首字节账本（内存 + ledger.jsonl）。需要 confirm=true，避免误清掉学习样本。",
    parameters: {
      type: "object",
      properties: { confirm: { type: "boolean" } },
      required: ["confirm"],
      additionalProperties: false,
    },
    output: { schema: { type: "object" }, render: (_args, value) => text(value.text) },
    execute: async (args = {}) => {
      if (args.confirm !== true) return { text: "没有清空：confirm 不是 true。", cleared: false };
      const before = ledger.routes().length;
      ledger.reset();
      return { text: `已清空 ${before} 条 route 的账本；策略配置未动。`, cleared: true };
    },
  });

  return () => {
    for (const dispose of disposers) {
      try {
        dispose();
      } catch {
        /* 已释放 */
      }
    }
  };
}
