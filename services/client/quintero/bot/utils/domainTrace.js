export function domainTrace(log, payload) {
  // Tag unico para grep
  log("info", "🧭 [DOMAIN_TRACE] " + JSON.stringify({
    ts: Date.now(),
    ...payload,
  }));
}
