const metrics = new Map();

export async function trace(agentName, method, operation) {
  const startedAt = performance.now();
  let success = true;
  try {
    return await operation();
  } catch (error) {
    success = false;
    throw error;
  } finally {
    const durationMs = performance.now() - startedAt;
    recordMetric(agentName, durationMs, success);
    console.info(`[Trace] ${agentName}.${method} completed in ${durationMs.toFixed(2)}ms`);
  }
}

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

export function getMetrics() {
  return Object.fromEntries(
    [...metrics.entries()].map(([name, value]) => [name, { ...value }]),
  );
}
