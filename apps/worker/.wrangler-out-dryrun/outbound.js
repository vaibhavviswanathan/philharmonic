var __defProp = Object.defineProperty;
var __name = (target, value) => __defProp(target, "name", { value, configurable: true });

// src/outbound/outbound.ts
var PRIVATE_RX = /^(?:10\.|192\.168\.|169\.254\.|127\.|::1|fc00:|fd00:)/i;
function isPrivateOrLoopback(hostname) {
  if (hostname === "localhost") return true;
  return PRIVATE_RX.test(hostname);
}
__name(isPrivateOrLoopback, "isPrivateOrLoopback");
function isGithub(hostname) {
  return hostname === "github.com" || hostname === "api.github.com" || hostname.endsWith(".github.com") || hostname.endsWith(".githubusercontent.com");
}
__name(isGithub, "isGithub");
function isAnthropic(hostname) {
  return hostname === "api.anthropic.com" || hostname.endsWith(".anthropic.com");
}
__name(isAnthropic, "isAnthropic");
function isPhilharmonic(hostname, philharmonicHost) {
  if (!philharmonicHost) return false;
  try {
    return hostname === new URL(philharmonicHost).hostname;
  } catch {
    return false;
  }
}
__name(isPhilharmonic, "isPhilharmonic");
var secretCache = /* @__PURE__ */ new Map();
function readSecret(binding) {
  const cached = secretCache.get(binding);
  if (cached) return cached;
  const fresh = binding.get();
  secretCache.set(binding, fresh);
  return fresh;
}
__name(readSecret, "readSecret");
var outbound_default = {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (isPrivateOrLoopback(url.hostname)) {
      console.log("outbound: blocked private", url.hostname, url.pathname);
      return new Response("Blocked: private address", { status: 403 });
    }
    const headers = new Headers(request.headers);
    headers.delete("cf-connecting-ip");
    headers.delete("cf-ipcountry");
    if (isGithub(url.hostname)) {
      headers.set("Authorization", `Bearer ${await readSecret(env.GITHUB_TOKEN)}`);
      headers.set("User-Agent", headers.get("User-Agent") ?? "philharmonic-agent");
    } else if (isAnthropic(url.hostname)) {
      headers.set("x-api-key", await readSecret(env.ANTHROPIC_API_KEY));
      headers.set("anthropic-version", headers.get("anthropic-version") ?? "2023-06-01");
    } else if (isPhilharmonic(url.hostname, env.PHILHARMONIC_HOST)) {
    } else {
      console.log("outbound: passthrough", url.hostname, url.pathname);
    }
    return fetch(url.toString(), {
      method: request.method,
      headers,
      body: request.body,
      redirect: "manual"
    });
  }
};
export {
  outbound_default as default
};
//# sourceMappingURL=outbound.js.map
