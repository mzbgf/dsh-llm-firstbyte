// dsh-llm-firstbyte —— 把「请求没发出去」与「上游缓冲/思考」分开。
//
// 挂 llm/stream（waterfall，返回 chunk 流），在这一层做三件事：
//   1. 起一个按 route 计算的首字节预算（budgetFor）
//   2. 用传输层探针记录「响应头 / 首字节」两个时刻（transport.js）
//   3. 超预算时按模式处理：diagnose 只记账告警；guard 立刻给 TIMEOUT 终止帧
//
// 所有统计按 provider/model 分账，并在账本里再按缓存命中/未命中分列。

import { ConfigStore, dataDir } from "./config.js";
import { RouteLedger } from "./ledger.js";
import { budgetFor, routeKey } from "./policy.js";
import { guardStream } from "./guard.js";
import { installProbe, instrumentFetchOptions, withRequestContext } from "./transport.js";
import { registerTools } from "./tools.js";

export const name = "llm-firstbyte";
export const inject = ["llm"];

export function apply(ctx, config = {}) {
  const store = new ConfigStore(dataDir(), config);
  const seed = store.read();
  const ledger = new RouteLedger(store.dir, { window: seed.window });
  const probe = installProbe();

  ctx.effect(() => {
    const dispose = ctx.on("llm/stream", (options, next) => {
      let current;
      try {
        current = store.read();
      } catch {
        current = seed;
      }
      if (!current.enabled) return next();

      // 适配器可能自带 fetch（options.fetch），优先就地换掉它
      instrumentFetchOptions(options, probe);

      const route = routeKey(options);
      const t0 = Date.now();
      const budgetMs = budgetFor(ledger.summary(route), current);

      let stream;
      try {
        // ALS：适配器内部的 fetch 会带上下文，归因不必靠事后猜
        stream = withRequestContext({ route, t0 }, () => next());
      } catch (error) {
        // dispatch 阶段就失败：交给宿主原本的失败路径
        try {
          ledger.record(route, {
            ttft: null,
            dur: Date.now() - t0,
            cls: "unknown",
            buffered: false,
            outcome: "dispatch-error",
            error: String(error?.message ?? error),
            budgetMs,
          });
        } catch {
          /* 记账失败不影响抛出 */
        }
        throw error;
      }

      return guardStream(stream, {
        route,
        budgetMs,
        mode: current.mode,
        probe,
        ledger,
        cfg: current,
        t0,
        // 惰性迭代时也把上下文带回去（适配器可能在第一次 pull 才发请求）
        run: (fn) => withRequestContext({ route, t0 }, fn),
        onDiag: ({ route: r, budgetMs: b, diag, elapsed }) => {
          try {
            const elapsedText = Number.isFinite(elapsed) ? `，已等 ${elapsed}ms` : "";
            ctx.logger?.warn?.(`[llm-firstbyte] ${r} 首字节超预算 ${b}ms${elapsedText}：${diag.text}`);
          } catch {
            /* 日志失败不影响请求 */
          }
        },
      });
    });

    return () => {
      try {
        dispose?.();
      } catch {
        /* 已释放 */
      }
    };
  }, "llm-firstbyte: stream guard");

  ctx.effect(() => registerTools(ctx, { store, ledger, probe }), "llm-firstbyte: tools");

  ctx.effect(
    () => () => {
      try {
        probe?.uninstall?.();
      } catch {
        /* 已还原 */
      }
    },
    "llm-firstbyte: fetch probe",
  );
}
