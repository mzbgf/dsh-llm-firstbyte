# dsh-llm-firstbyte

把两件在客户端看来一模一样的事分开：

- **请求根本没发出去**（连接挂了、上游没接）—— 一直等，等到 300s 空闲超时才失败；
- **请求发出去了，上游在缓冲或长思考** —— 同样一直等，但它是正常的，只是首字节晚。

两者在解析层完全同构（都是零事件），只有 HTTP 层能分开。这个插件就在那一层装探针，然后把「该等多久」变成按 route 学出来的预算。

## 三层判定

| 观测 | 含义 | 动作 |
|---|---|---|
| 连响应头都没有 | 请求很可能没送达 | 尽快失败（guard 模式） |
| 有响应头、无响应体字节 | 已送达，上游在缓冲/思考 | 抬预算，别误杀 |
| 有响应体字节、无可解析事件 | 送达正常，问题在流式解析/协议 | 报出来，别当网络问题查 |
| 适配器不走全局 fetch（看不到传输层） | 无法区分 | 明说 `unobserved`，按 route 先验给预算 |

探针只记两个时刻（`headersAt`、`firstBodyAt`），响应体是直通包装，不缓冲、不改语义；204/304/错误响应原样返回。

## 预算怎么算

预算的含义只有一个：**从请求发出到第一个可解析事件**允许多久。

```
预算 = clamp( max(该 route 的 p99.5 × 1.2, hitMs), hitMs, capMs )
若 缓冲占比 ≥ bufferFloor（默认 15%）→ 预算 = max(预算, bufferedMs)
样本不足 minSamples 条 → 直接用 missMs
```

默认值来自 8,165 条真实成功请求的统计：

| 分类 | p50 | p90 | p99 | 建议预算 |
|---|---|---|---|---|
| 命中缓存（91.2%） | 4.9s | 8.8s | 19–20.7s | **30s** |
| 未命中/部分命中（8.8%） | 9.9s | 20.5s | 33–37s | **45s** |
| 缓冲型 route（首字节≈完成时刻） | 13.2s | 26.5s | 36.6s | **120s** |

`缓冲占比` = 首字节落在回复最后 20% 的请求比例（只统计 >10s 的回复；短回复天然只有一簇，不算缓冲）。这个值高的 route，首字节阈值没有语义 —— 对它设 45–60s 等于砍长回复。

## 两种模式

- `diagnose`（默认）：超预算只记账 + 一条 `warn` 日志，**不打断请求**。先跑几天攒样本。
- `guard`：超预算立刻吐一个 `finish` 终止帧（`failure.code = "TIMEOUT"`，消息里带诊断），交给宿主既有的重试策略 —— 把 300s 的沉默等待换成一个可重试的快速失败。

为什么吐终止帧而不是抛异常：宿主的约定是「适配器失败转成终止帧、中间件异常原样抛出」。抛出去会把整条链炸掉，吐帧才会走重试。

## 安装

```bash
# 在宿主的插件市场/plugin_manager 里按 git+https 安装，或在 profile 里：
#   dsh plugin add @rain/dsh-llm-firstbyte@git+https://github.com/<you>/dsh-llm-firstbyte
```

bundle patch 已带默认 config（`cordis.patch.yml`），装上即生效为 `diagnose` 模式。

本地试跑：

```bash
node --test test/     # 14 个用例，含本地 HTTP 服务器的字节计时验证
```

## 配置

落在 `$DSH_HOME/plugin-data/llm-firstbyte/config.json`，改完立刻生效，不用重启。

| 键 | 默认 | 说明 |
|---|---|---|
| `enabled` | `true` | 总开关 |
| `mode` | `diagnose` | `diagnose` / `guard` |
| `hitMs` | `30000` | 预算下限，也是命中缓存的默认预算 |
| `missMs` | `45000` | 未命中/未知 route 的默认预算 |
| `bufferedMs` | `120000` | 缓冲型 route 的预算 |
| `capMs` | `300000` | 上限，防止学习把阈值越抬越高 |
| `minSamples` | `20` | 攒够多少条才开始按 route 学习 |
| `bufferFloor` | `0.15` | 缓冲占比超过它就判缓冲型 |
| `window` | `400` | 每个 route 内存里保留的样本数 |

## 工具

| 工具 | 用途 |
|---|---|
| `llm_latency_report` | 按 route 看命中/未命中分列的首字节分位、缓冲占比、判定与当前预算；`recent:N` 可列最近几次的诊断 |
| `llm_latency_policy` | 读/改上面那张表的任意字段 |
| `llm_latency_reset` | 清账（需 `confirm:true`） |

## 数据

- `plugin-data/llm-firstbyte/ledger.jsonl`：每次请求一行（append-only），字段含 `ttft / dur / cls / cacheRead / buffered / outcome / overBudget / diagnosis / headersMs / firstBodyMs`。
- 每个 route 内存只留最近 `window` 条；盘上保留完整历史，供离线复盘。

## 已验证与未验证

已验证（`node --test`）：分位数与最近秩、缓存分类、缓冲判定、预算推导、账本落盘/重载、配置补丁、探针对「头早到/体晚到」的分离与响应体完整性、三种诊断口径、guard 的终止帧与源头关闭、diagnose 的不打断行为。

未验证（需要在真宿主里跑）：
- 适配器是否真的走全局 `fetch`。openai SDK 7.19 的 client 用 `getDefaultFetch()` 取全局（每次构造 client 时解析），所以插件先装好就能拦到；若某适配器把 fetch 钉死在别处，插件会在报告里显示 `unobserved` 并退化为「按 route 先验给预算」。
- `llm/stream` 的 `options.fetch` 是否存在。存在时会就地替换（`instrumentFetchOptions`），归因比全局补丁更准。

## 设计取舍

- **不做「猜内容」**：插件不试图从文本判断回复长不长，只用可观测的字节时刻与历史形态。
- **诊断优先于拦截**：默认不改变任何请求的结果，先让数据说话；要收紧再切 `guard`。
- **按 route 而不是按模型族**：同一个 `deepseek-v4.1-flash` 在不同 provider 下的尾巴差一倍，按 route 记才不被平均掉。
