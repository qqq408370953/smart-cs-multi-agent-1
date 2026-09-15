import { SpanStatusCode, trace as otelApiTrace } from "@opentelemetry/api";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { NodeSDK } from "@opentelemetry/sdk-node";

// 进程内指标仓库与OpenTelemetry Span同时记录，便于无Collector时继续观察基本指标。
const metrics = new Map();
let telemetrySdk = null;

/** 配置OTLP端点时启动真实OpenTelemetry NodeSDK；未配置时API自动使用无操作Provider。 */
export function initTracing({
  serviceName = process.env.OTEL_SERVICE_NAME || "smart-cs-node",
  endpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT,
} = {}) {
  if (telemetrySdk || !endpoint) return telemetrySdk;
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
  const startedAt = performance.now();
  let success = true;
  const tracer = otelApiTrace.getTracer("smart-cs-multi-agent-node", "1.1.0");
  return tracer.startActiveSpan(`${agentName}.${method}`, async (span) => {
    span.setAttribute("agent.name", agentName);
    span.setAttribute("agent.method", method);
    try {
      const result = await operation();
      span.setStatus({ code: SpanStatusCode.OK });
      return result;
    } catch (error) {
      success = false;
      span.recordException(error);
      span.setStatus({ code: SpanStatusCode.ERROR, message: error.message });
      throw error;
    } finally {
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
