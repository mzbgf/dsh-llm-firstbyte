// 传输层探针：只做一件事——把「响应头到达」与「响应体第一个字节到达」记下来。
//
// 为什么必须在 fetch 层：llm/stream 拿到的是**解析后**的事件。上游整段缓冲时，
// 解析层与「请求根本没发出去」完全同构（都是零事件），只有 HTTP 层能分开：
//   · 连响应头都没有      → 请求很可能没送达
//   · 有响应头、无响应体  → 已送达，上游在缓冲/思考
//   · 有响应体、无事件    → 送达且在回字节，是解析/协议问题
//
// 归因：优先用 AsyncLocalStorage（钩子里 run 一下，适配器内部的 fetch 就在同一个
// 异步上下文里）；拿不到时退回「时间窗 + 未认领」匹配，并标 attribution="time"。
// 探针本身绝不改变响应语义：只在 2xx 且有 body 时套一层直通流。

import { AsyncLocalStorage } from "node:async_hooks";

const GLOBAL_KEY = Symbol.for("@rain/dsh-llm-firstbyte/probe");
const als = new AsyncLocalStorage();

export function withRequestContext(context, fn) {
  return als.run(context, fn);
}

export function currentRequestContext() {
  return als.getStore();
}

function urlOf(input) {
  if (typeof input === "string") return input;
  if (input && typeof input.url === "string") return input.url;
  try {
    return String(input);
  } catch {
    return "";
  }
}

function looksLikeLlm(url) {
  return /\/chat\/completions|\/completions|\/messages|\/responses|\/stream/i.test(url);
}

function wrapBody(response, record) {
  const reader = response.body.getReader();
  const stream = new ReadableStream({
    async pull(controller) {
      let result;
      try {
        result = await reader.read();
      } catch (error) {
        controller.error(error);
        return;
      }
      if (result.done) {
        controller.close();
        return;
      }
      if (record.firstBodyAt === null) {
        record.firstBodyAt = Date.now();
        record.firstBodyBytes = result.value?.byteLength ?? 0;
      }
      record.bytes = (record.bytes ?? 0) + (result.value?.byteLength ?? 0);
      controller.enqueue(result.value);
    },
    cancel(reason) {
      return reader.cancel(reason);
    },
  });

  const wrapped = new Response(stream, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
  // 保持 url / redirected，避免依赖它们的客户端读到空值
  for (const key of ["url", "redirected", "type"]) {
    try {
      Object.defineProperty(wrapped, key, { value: response[key], configurable: true });
    } catch {
      /* 只读属性定义失败就放弃，不影响 body */
    }
  }
  record.wrapped = true;
  return wrapped;
}

/**
 * 把任意 fetch 实现包成「记两个时刻」的版本。
 * 全局探针用它包 globalThis.fetch；适配器自带 fetch 时（llm/stream 的 options.fetch）
 * 用它就地替换——这样不必依赖全局。
 */
export function makeInstrumentedFetch(real, probe) {
  return async function instrumentedFetch(input, init) {
    const context = als.getStore() ?? null;
    const record = {
      url: urlOf(input),
      t0: Date.now(),
      headersAt: null,
      firstBodyAt: null,
      firstBodyBytes: 0,
      status: null,
      bytes: 0,
      context,
      claimed: false,
    };
    probe.calls.push(record);
    while (probe.calls.length > probe.maxCalls) probe.calls.shift();

    let response;
    try {
      response = await real(input, init);
    } catch (error) {
      record.failedAt = Date.now();
      record.error = String(error?.message ?? error);
      throw error;
    }

    record.headersAt = Date.now();
    record.status = response.status;

    // 只包装与 LLM 相关的流量：带 ALS 上下文的（我们发起的）或路径像推理端点的。
    // 其余（web_fetch、下载、插件自己的 HTTP）原样返回，不改变语义、不增加一跳。
    const relevant = Boolean(record.context) || looksLikeLlm(record.url);
    if (!relevant) return response;

    // 无 body、204/304：原样返回，别碰语义
    if (!response.body || response.status === 204 || response.status === 304) return response;

    try {
      return wrapBody(response, record);
    } catch {
      return response;
    }
  };
}

export function installProbe({ maxCalls = 200 } = {}) {
  const existing = globalThis[GLOBAL_KEY];
  // 只有「仍然挂在全局 fetch 上」的探针才算已安装；被 uninstall 过的要重装
  if (existing?.active) return existing;
  const real = globalThis.fetch;
  if (typeof real !== "function") return null;

  const probe = {
    calls: [],
    maxCalls,
    patchedAt: Date.now(),

    /** 供 llm/stream 钩子认领本次请求对应的那条 fetch 记录。 */
    take(route, since) {
      const from = Number.isFinite(since) ? since - 500 : 0;
      const pool = this.calls.filter((c) => !c.claimed && c.t0 >= from);

      const owned = pool
        .filter((c) => c.context?.route === route)
        .sort((a, b) => a.t0 - b.t0);
      const chosen =
        owned[0] ??
        pool
          .filter((c) => looksLikeLlm(c.url))
          .sort((a, b) => Math.abs(a.t0 - since) - Math.abs(b.t0 - since))[0] ??
        pool.sort((a, b) => Math.abs(a.t0 - since) - Math.abs(b.t0 - since))[0] ??
        null;

      if (!chosen) return null;
      chosen.claimed = true;
      chosen.attribution = owned[0] ? "als" : "time";
      return chosen;
    },

    /** 诊断用：最近 n 条记录的快照（去掉持有引用）。 */
    recent(n = 10) {
      return this.calls.slice(-n).map((c) => ({
        url: c.url,
        t0: c.t0,
        headersMs: c.headersAt ? c.headersAt - c.t0 : null,
        firstBodyMs: c.firstBodyAt ? c.firstBodyAt - c.t0 : null,
        status: c.status,
        bytes: c.bytes ?? 0,
        route: c.context?.route ?? null,
      }));
    },
  };

  const patched = makeInstrumentedFetch(real, probe);
  patched.__firstbyte = true;

  try {
    globalThis.fetch = patched;
  } catch {
    return null;
  }

  probe.uninstall = () => {
    probe.active = false;
    if (globalThis.fetch === patched) globalThis.fetch = real;
  };
  probe.active = true;
  globalThis[GLOBAL_KEY] = probe;
  return probe;
}

/**
 * 适配器自带 fetch（llm/stream 的 options.fetch）时就地替换。
 * 有些 provider 适配器会 `new OpenAI({ fetch })` 把实现钉死，全局补丁打不进去；
 * 这种路径上归因反而更准——同一次调用、同一个对象。
 */
export function instrumentFetchOptions(options, probe) {
  if (!options || typeof options.fetch !== "function" || !probe) return null;
  if (options.fetch.__firstbyte) return options.fetch;
  const wrapped = makeInstrumentedFetch(options.fetch, probe);
  wrapped.__firstbyte = true;
  try {
    options.fetch = wrapped;
  } catch {
    return null;
  }
  return wrapped;
}

/**
 * 超时诊断：把「沉默」拆成三种可行动的原因。
 * @param record 探针记录（可能为 null —— 适配器没走全局 fetch）
 * @param since 本次请求起点
 * @param budgetMs 首字节预算
 */
export function diagnoseSilence(record, since, budgetMs) {
  if (!record) {
    return {
      kind: "unobserved",
      text: `传输层不可见（适配器未走全局 fetch）：${budgetMs}ms 沉默无法区分「未送达」与「上游缓冲」`,
    };
  }
  const headersMs = record.headersAt ? record.headersAt - since : null;
  const firstBodyMs = record.firstBodyAt ? record.firstBodyAt - since : null;

  if (headersMs === null) {
    const failed = record.error ? `（连接错误：${record.error}）` : "";
    return { kind: "not-delivered", text: `${budgetMs}ms 内没有响应头${failed} → 请求很可能没有送达` };
  }
  if (firstBodyMs === null) {
    return {
      kind: "headers-only",
      text: `响应头 ${headersMs}ms 到达，但 ${budgetMs}ms 内没有响应体字节 → 已送达，上游在缓冲或思考`,
    };
  }
  return {
    kind: "no-events",
    text: `首个字节 ${firstBodyMs}ms 到达，但 ${budgetMs}ms 内没有可解析事件 → 送达正常，问题在流式解析/协议`,
  };
}
