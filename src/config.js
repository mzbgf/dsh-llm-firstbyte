// 配置与数据目录。
// 配置落在 $DSH_HOME/plugin-data/llm-firstbyte/config.json，可被工具改写；
// cordis 行里的 config 只是首次运行时的种子。

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const DEFAULTS = Object.freeze({
  enabled: true,
  // diagnose：只记录与告警，不打断请求（默认）
  // guard：超过预算就发一个 TIMEOUT 终止帧，交给宿主的重试策略
  mode: "diagnose",
  // 命中缓存时的首字节预算
  hitMs: 30_000,
  // 未命中/部分命中时的首字节预算
  missMs: 45_000,
  // 判定为「缓冲型」的 route，首字节预算抬到这里（因为它的首字节≈完成时刻）
  bufferedMs: 120_000,
  // 任何预算的上限，防止学习把阈值越抬越高
  capMs: 300_000,
  // 样本少于此数时用默认预算，不做学习
  minSamples: 20,
  // 缓冲样本占比超过它 → 判为缓冲型 route
  bufferFloor: 0.15,
  // 每个 route 在内存里保留的样本数
  window: 400,
  // 判定「缓冲」的最短回复时长：短回复本来就一簇，不能算缓冲
  bufferMinDurMs: 10_000,
});

export function dshHome() {
  return process.env.DSH_HOME || join(homedir(), ".dsh");
}

export function dataDir() {
  const dir = join(dshHome(), "plugin-data", "llm-firstbyte");
  mkdirSync(dir, { recursive: true });
  return dir;
}

export class ConfigStore {
  constructor(dir, seed = {}) {
    this.dir = dir;
    this.path = join(dir, "config.json");
    this.seed = seed && typeof seed === "object" ? seed : {};
    if (!existsSync(this.path)) this.#write(this.read());
  }

  #write(value) {
    try {
      writeFileSync(this.path, JSON.stringify(value, null, 2));
    } catch {
      /* 配置写不进去不该拖垮插件：内存里的默认值仍可用 */
    }
  }

  read() {
    let stored = {};
    try {
      stored = JSON.parse(readFileSync(this.path, "utf8")) ?? {};
    } catch {
      stored = {};
    }
    const merged = { ...DEFAULTS, ...this.seed, ...stored };
    // 类型纠偏：外部手改过的文件可能带字符串数字
    for (const [key, fallback] of Object.entries(DEFAULTS)) {
      if (typeof fallback === "number") {
        // 只有整数型默认值才取整：bufferFloor 是 0.15，取整会变成 0，
        // 结果是「任何一条缓冲样本都算超阈值」，预算直接跳到 bufferedMs。
        const n = Number(merged[key]);
        // 落盘的坏值要有出口：默认值为正时，非正值一律回落，别让 0 变成「阈值恒真」
        if (!Number.isFinite(n) || (fallback > 0 && n <= 0)) merged[key] = fallback;
        else merged[key] = Number.isInteger(fallback) ? Math.round(n) : n;
      } else if (typeof fallback === "boolean") {
        merged[key] = merged[key] !== false;
      } else if (typeof fallback === "string") {
        merged[key] = typeof merged[key] === "string" ? merged[key] : fallback;
      }
    }
    if (merged.mode !== "guard") merged.mode = "diagnose";
    return merged;
  }

  patch(partial = {}) {
    const next = { ...this.read() };
    for (const [key, raw] of Object.entries(partial)) {
      if (!(key in DEFAULTS)) continue;
      const fallback = DEFAULTS[key];
      if (typeof fallback === "number") {
        const n = Number(raw);
        if (!Number.isFinite(n) || (fallback > 0 && n <= 0)) continue;
        next[key] = Number.isInteger(fallback) ? Math.round(n) : n;
      } else if (typeof fallback === "boolean") {
        next[key] = Boolean(raw);
      } else if (key === "mode") {
        next[key] = raw === "guard" ? "guard" : "diagnose";
      } else {
        next[key] = String(raw);
      }
    }
    this.#write(next);
    return next;
  }
}
