// 流守卫：只盯一件事——第一个事件之前允许多久。
//
// 两种模式：
//   diagnose（默认）：超预算只记录 + 告警，不打断请求。用来先攒样本。
//   guard：超预算立即吐一个 TIMEOUT 终止帧，交给宿主的重试策略，把 300s 的
//          沉默等待缩短成一个可重试的快速失败。
//
// 为什么吐 finish 而不是 throw：宿主文档写明「中间件/消费者的异常会原样抛出」，
// 而适配器失败会被转成终止帧。所以要模仿 adapterFailureChunk 的形状，让宿主
// 按正常失败路径重试，而不是把整条链炸掉。

import { classifyUsage, isBuffered } from "./ledger.js";
import { diagnoseSilence } from "./transport.js";

const DEADLINE = Symbol("firstbyte.deadline");

export async function* guardStream(source, opts) {
  const {
    route,
    budgetMs,
    mode,
    probe,
    ledger,
    cfg,
    t0,
    run = (fn) => fn(),
    onDiag = () => {},
  } = opts;

  const iterator = typeof source?.[Symbol.asyncIterator] === "function" ? source[Symbol.asyncIterator]() : null;
  if (!iterator || typeof iterator.next !== "function") {
    yield* source;
    return;
  }

  let timer = null;
  let resolveDeadline = null;
  const deadline = new Promise((resolve) => {
    resolveDeadline = resolve;
    timer = setTimeout(() => resolve(DEADLINE), budgetMs);
    if (typeof timer?.unref === "function") timer.unref();
  });
  const disarm = () => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
  };

  let firstAt = null;
  let usage = null;
  let record = null;
  let overBudget = false;
  let diagnosis = null;
  let settled = false;

  const settle = (outcome, extra = {}) => {
    if (settled) return;
    settled = true;
    const now = Date.now();
    const dur = now - t0;
    const ttft = firstAt ? firstAt - t0 : null;
    const cls = classifyUsage(usage);
    try {
      ledger?.record(route, {
        ttft,
        dur,
        cls: cls.cls,
        cacheRead: cls.cacheRead,
        input: cls.input,
        buffered: firstAt ? isBuffered(ttft, dur, cfg.bufferMinDurMs) : false,
        outcome,
        overBudget,
        diagnosis,
        budgetMs,
        headersMs: record?.headersAt ? record.headersAt - t0 : null,
        firstBodyMs: record?.firstBodyAt ? record.firstBodyAt - t0 : null,
        status: record?.status ?? null,
        attribution: record?.attribution ?? null,
        ...extra,
      });
    } catch {
      /* 记账失败不影响请求 */
    }
  };

  try {
    while (true) {
      const nextPromise = Promise.resolve()
        .then(() => run(() => iterator.next()))
        .then(
          (value) => ({ kind: "next", value }),
          (error) => ({ kind: "throw", error }),
        );

      const raced = firstAt === null ? await Promise.race([nextPromise, deadline]) : await nextPromise;

      if (raced === DEADLINE) {
        record = record ?? probe?.take(route, t0) ?? null;
        const diag = diagnoseSilence(record, t0, budgetMs);
        diagnosis = diag.kind;
        onDiag({ route, budgetMs, diag, elapsed: Date.now() - t0 });

        if (mode === "guard") {
          settle("timeout");
          disarm();
          try {
            await Promise.resolve(run(() => iterator.return?.()));
          } catch {
            /* 关闭源头失败不改变结论 */
          }
          yield {
            type: "finish",
            reason: {
              kind: "error",
              failure: {
                code: "TIMEOUT",
                message: `first-byte budget ${budgetMs}ms exceeded (${route}): ${diag.text}`,
              },
            },
          };
          return;
        }

        // diagnose：把这次标成越界，但继续等真实结果，不制造失败
        overBudget = true;
        const value = await nextPromise;
        if (value.kind === "throw") {
          settle("error", { error: String(value.error?.message ?? value.error) });
          throw value.error;
        }
        if (value.value?.done) {
          settle("empty");
          return;
        }
        firstAt = Date.now();
        const chunk = value.value.value;
        if (chunk?.type === "usage") usage = chunk.usage;
        if (chunk?.type === "finish") {
          settle("finished");
          yield chunk;
          return;
        }
        yield chunk;
        continue;
      }

      if (raced.kind === "throw") {
        settle("error", { error: String(raced.error?.message ?? raced.error) });
        disarm();
        throw raced.error;
      }

      const step = raced.value;
      if (step?.done) {
        settle(firstAt ? "completed" : "empty");
        disarm();
        return;
      }

      const chunk = step?.value;
      if (firstAt === null) {
        firstAt = Date.now();
        disarm();
        record = record ?? probe?.take(route, t0) ?? null;
      }
      if (chunk?.type === "usage") usage = chunk.usage;
      if (chunk?.type === "finish") {
        settle("finished", { finishKind: chunk?.reason?.kind ?? null });
        disarm();
        yield chunk;
        return;
      }
      yield chunk;
    }
  } finally {
    disarm();
    if (resolveDeadline) resolveDeadline = null;
  }
}
