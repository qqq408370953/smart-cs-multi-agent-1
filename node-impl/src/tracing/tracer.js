// OpenTelemetry API 创建 Span；Exporter 和 NodeSDK 负责把 Span 批量发送到 Collector/Jaeger。
import { SpanStatusCode, trace as otelApiTrace } from "@opentelemetry/api";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { NodeSDK } from "@opentelemetry/sdk-node";

// 进程内指标仓库与 OpenTelemetry Span 同时记录，便于无 Collector 时继续观察基本指标。
// Span 表示一次操作的时间区间；Trace 是存在父子关系的一组 Span，能还原完整请求链路。
const metrics = new Map();
let telemetrySdk = null;

/** 配置OTLP端点时启动真实OpenTelemetry NodeSDK；未配置时API自动使用无操作Provider。 */
export function initTracing({
  serviceName = process.env.OTEL_SERVICE_NAME || "smart-cs-node",
  endpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT,
} = {}) {
  // 保证进程内只启动一个 SDK；没有 endpoint 时 OpenTelemetry API 使用 no-op provider。
  if (telemetrySdk || !endpoint) return telemetrySdk;
  // OTLP HTTP exporter 通常要求最终路径为 /v1/traces，这里兼容用户传根地址或完整地址。
  const url = endpoint.endsWith("/v1/traces")
    ? endpoint
    : `${endpoint.replace(/\/$/, "")}/v1/traces`;
  telemetrySdk = new NodeSDK({
    serviceName,
    traceExporter: new OTLPTraceExporter({ url }),
  });
  telemetrySdk.start();
  console.info(`[Tracer] OpenTelemetry已启用: ${serviceName} -> ${url}`);
  return telemetrySdk;
}

/** 刷新并关闭OpenTelemetry SDK，供容器优雅退出和测试清理。 */
export async function shutdownTracing() {
  if (!telemetrySdk) return;
  await telemetrySdk.shutdown();
  telemetrySdk = null;
}

/** 包装Agent操作，在finally中记录耗时与成功状态，异常保持原样抛出。 */
export async function trace(agentName, method, operation) {
  // performance.now 使用单调时钟，更适合测耗时，不受系统时间校准影响。
  const startedAt = performance.now();
  let success = true;
  const tracer = otelApiTrace.getTracer("smart-cs-multi-agent-node", "1.1.0");
  // startActiveSpan 会在回调期间把新 Span 放入活动上下文；内部 Span 可自动成为它的子 Span。
  return tracer.startActiveSpan(`${agentName}.${method}`, async (span) => {
    span.setAttribute("agent.name", agentName);
    span.setAttribute("agent.method", method);
    try {
      const result = await operation();
      span.setStatus({ code: SpanStatusCode.OK });
      return result;
    } catch (error) {
      // 记录异常后继续 throw，观测代码不能吞掉业务错误或改变原控制流。
      success = false;
      span.recordException(error);
      span.setStatus({ code: SpanStatusCode.ERROR, message: error.message });
      throw error;
    } finally {
      // finally 确保成功与失败都记录指标并结束 Span，否则会产生永不闭合的追踪数据。
      const durationMs = performance.now() - startedAt;
      span.setAttribute("agent.duration_ms", durationMs);
      span.setAttribute("agent.success", success);
      recordMetric(agentName, durationMs, success);
      span.end();
      console.info(`[Trace] ${agentName}.${method} completed in ${durationMs.toFixed(2)}ms`);
    }
  });
}

/** 累计单个Agent的调用次数、总/平均耗时和错误率。 */
export function recordMetric(agentName, durationMs, success = true) {
  // 这里是进程内累计值；重启会清空，多实例之间也不会自动聚合。
  const current = metrics.get(agentName) ?? {
    total_calls: 0,
    total_time_ms: 0,
    error_count: 0,
    avg_time_ms: 0,
    error_rate: 0,
  };

  current.total_calls += 1;
  current.total_time_ms += durationMs;
  if (!success) current.error_count += 1;
  current.avg_time_ms = current.total_time_ms / current.total_calls;
  current.error_rate = current.error_count / current.total_calls;
  metrics.set(agentName, current);
}

/** 返回指标快照，防止API调用方修改内部聚合数据。 */
export function getMetrics() {
  return Object.fromEntries(
    [...metrics.entries()].map(([name, value]) => [name, { ...value }]),
  );
}
