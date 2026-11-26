// route 键、预算推导、route 类型判定。
// 预算的含义只有一个：**从请求发出到第一个可解析事件**允许多久。

export function routeKey(options) {
  const provider = typeof options?.provider === "string" && options.provider ? options.provider : "unknown";
  const model = typeof options?.model === "string" && options.model ? options.model : "unknown";
  return `${provider}/${model}`;
}

/**
 * 预算 = max(该 route 的 p99.5 × 1.2, hit 下限)，缓冲型 route 再抬到 bufferedMs。
 * 样本不足时直接用 missMs：未知 route 上宁可慢一点，也别把长回复误杀。
 */
export function budgetFor(summary, cfg) {
  const known = summary.n >= cfg.minSamples;
  let ms = cfg.missMs;

  if (known && Number.isFinite(summary.p995)) {
    ms = Math.max(cfg.hitMs, Math.ceil((summary.p995 * 1.2) / 1000) * 1000);
  }
  if (known && summary.bufferedRatio >= cfg.bufferFloor) {
    ms = Math.max(ms, cfg.bufferedMs);
  }
  return Math.min(Math.max(ms, cfg.hitMs), cfg.capMs);
}

export function routeVerdict(summary, cfg) {
  if (summary.n < cfg.minSamples) return "样本不足";
  if (summary.bufferedRatio >= cfg.bufferFloor) return "缓冲型";
  if (Number.isFinite(summary.p995) && summary.p995 >= 0.6 * cfg.bufferedMs) return "慢流式";
  return "流式";
}

export function routeNote(summary, cfg) {
  const verdict = routeVerdict(summary, cfg);
  if (verdict === "样本不足") return `攒到 ${cfg.minSamples} 条样本后才开始按 route 学习，先用默认预算`;
  if (verdict === "缓冲型") {
    return `首字节落在回复尾部的情况占 ${(summary.bufferedRatio * 100).toFixed(0)}%，首字节阈值对它无语义，主防线应是总时长`;
  }
  if (verdict === "慢流式") return "首字节能反映真实等待，但尾部很宽，预算应按 p99.5 而不是中位数";
  return "首字节能区分「没发出」与「在等」，当前预算可用";
}
