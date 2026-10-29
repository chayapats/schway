/** Sanitized xAI protocol failures, including untrusted text that must never escape. */
export const GROK_ERROR_FIXTURES = [
  { name: "spending limit", status: 403, code: "personal-team-blocked:spending-limit", expected: "quota-exceeded", message: "Grok usage limit reached", headers: {} },
  { name: "another spending limit", status: 401, code: "team-blocked:spending-limit", expected: "quota-exceeded", message: "Grok usage limit reached", headers: {} },
  { name: "plan rejection", status: 403, code: "subscription-required", expected: "rejected", message: "Your Grok plan doesn't include API access", headers: {} },
  { name: "Cloudflare challenge", status: 403, code: "personal-team-blocked:spending-limit", expected: "integration-unavailable", message: "Grok access temporarily unavailable", headers: { "cf-mitigated": "challenge" } },
  { name: "401 Cloudflare challenge", status: 401, code: "subscription-required", expected: "integration-unavailable", message: "Grok access temporarily unavailable", headers: { "cf-mitigated": "challenge" } },
] as const;

/** Create a fresh denial response whose free-form body is never public guidance. */
export function grokErrorResponse(fixture: (typeof GROK_ERROR_FIXTURES)[number]): Response {
  return Response.json({ code: fixture.code, error: "untrusted-body-sentinel" }, { status: fixture.status, headers: fixture.headers });
}
