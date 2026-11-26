// 按 route 记账：首字节、总时长、缓存命中、是否缓冲型、是否超时。
// 内存里每个 route 只留最近 window 条；落盘是 append-only JSONL，便于事后核。

import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** 最近秩百分位：样本少时也不会外推出样本里没有的值。 */
export function percentile(sortedAsc, p) {
  if (!Array.isArray(sortedAsc) || sortedAsc.length === 0) return null;
  const idx = Math.min(sortedAsc.length - 1, Math.max(0, Math.ceil(p * sortedAsc.length) - 1));
  return sortedAsc[idx];
}

/**
 * 缓存分类：usage 里 `inputTokens` 是未命中（要重新 prefill）的部分，
 * `cacheReadTokens` 是命中部分。命中率 ≥ 50% 记为 hit。
 */
export function classifyUsage(usage) {
  const read = usage?.cacheReadTokens;
  const input = Number.isFinite(usage?.inputTokens) ? usage.inputTokens : 0;
  if (read === undefined || read === null || !Number.isFinite(read)) {
    return { cls: "unknown", cacheRead: null, input };
  }
  const total = read + input;
  const ratio = total > 0 ? read / total : 0;
  return { cls: ratio >= 0.5 ? "hit" : "miss", cacheRead: read, input, ratio };
}

/**
 * 缓冲判定：首字节落在回复的最后 20%，且回复本身够长。
 * 短回复天然只有一簇，不能算缓冲——这条下限就是为了排除它们。
 */
export function isBuffered(ttft, dur, minDurMs = 10_000, tail = 0.8) {
  if (!Number.isFinite(ttft) || !Number.isFinite(dur)) return false;
  return dur >= minDurMs && ttft >= dur * tail;
}

function sortedNumbers(list) {
  return list.filter((n) => Number.isFinite(n)).sort((a, b) => a - b);
}

export class RouteLedger {
  constructor(dir, { window = 400, file = "ledger.jsonl", maxLines = 40_000 } = {}) {
    this.dir = dir;
    this.path = join(dir, file);
    this.window = window;
    this.byRoute = new Map();  // 字段名不能叫 routes：会盖掉同名方法
    this.#load(maxLines);
  }

  #load(maxLines) {
    if (!existsSync(this.path)) return;
    let text = "";
    try {
      text = readFileSync(this.path, "utf8");
    } catch {
      return;
    }
    const lines = text.split("\n");
    const start = Math.max(0, lines.length - maxLines);
    for (let i = start; i < lines.length; i += 1) {
      const line = lines[i].trim();
      if (!line) continue;
      try {
        this.#push(JSON.parse(line));
      } catch {
        /* 半截行或旧版本样本：跳过，不影响其余 */
      }
    }
  }

  #push(sample) {
    if (!sample || typeof sample.route !== "string") return;
    const list = this.byRoute.get(sample.route) ?? [];
    list.push(sample);
    // 只裁内存窗口；盘上保留完整历史，供离线复盘
    while (list.length > this.window) list.shift();
    this.byRoute.set(sample.route, list);
  }

  record(route, sample) {
    const row = { at: Date.now(), route, ...sample };
    this.#push(row);
    try {
      appendFileSync(this.path, JSON.stringify(row) + "\n");
    } catch {
      /* 记账失败不影响请求本身 */
    }
    return row;
  }

  summary(route) {
    const list = this.byRoute.get(route) ?? [];
    const n = list.length;
    const ttfts = sortedNumbers(list.map((s) => s.ttft));
    const hits = sortedNumbers(list.filter((s) => s.cls === "hit").map((s) => s.ttft));
    const misses = sortedNumbers(list.filter((s) => s.cls === "miss").map((s) => s.ttft));
    const buffered = list.filter((s) => s.buffered).length;
    const timeouts = list.filter((s) => s.outcome === "timeout").length;
    const wouldTimeout = list.filter((s) => s.outcome === "would-timeout").length;
    return {
      route,
      n,
      hitN: hits.length,
      missN: misses.length,
      bufferedRatio: n > 0 ? buffered / n : 0,
      timeouts,
      wouldTimeout,
      p50: percentile(ttfts, 0.5),
      p90: percentile(ttfts, 0.9),
      p99: percentile(ttfts, 0.99),
      p995: percentile(ttfts, 0.995),
      max: ttfts.length ? ttfts[ttfts.length - 1] : null,
      hitP50: percentile(hits, 0.5),
      hitP995: percentile(hits, 0.995),
      missP50: percentile(misses, 0.5),
      missP995: percentile(misses, 0.995),
      recent: list.slice(-5),
    };
  }

  routes() {
    return [...this.byRoute.keys()].sort();
  }

  reset() {
    this.byRoute.clear();
    try {
      writeFileSync(this.path, "");
    } catch {
      /* 清不掉就只清内存 */
    }
  }
}
