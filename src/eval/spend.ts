import type { EvalMetrics } from "./metrics.ts";

/** USD per million tokens for one model. */
export interface TokenPrice {
  inputPerMillion: number;
  outputPerMillion: number;
}

/** Spend estimated from reported usage; `exact` is false when some attempts reported no usage. */
export interface SpendEstimate {
  usd: number;
  exact: boolean;
}

/** Price of routes that never bill per token. */
export const FREE: TokenPrice = { inputPerMillion: 0, outputPerMillion: 0 };

/** Published API-key list prices; models absent here need explicit prices. */
const PRICES: Record<string, TokenPrice> = {
  "openai:gpt-5": { inputPerMillion: 1.25, outputPerMillion: 10 },
  "openai:gpt-5-mini": { inputPerMillion: 0.25, outputPerMillion: 2 },
};

/** Resolve a route's price: explicit flags win, offline and subscription routes are free, unknown paid models are `undefined`. */
export function resolvePrice(provider: string, model: string, explicit?: TokenPrice): TokenPrice | undefined {
  if (provider === "scripted" || provider === "subscription") return FREE;
  if (explicit) return explicit;
  return PRICES[`${provider}:${model}`];
}

/** Convert recorded token totals to USD without treating missing usage as proof of zero spend. */
export function estimateSpendUsd(metrics: Pick<EvalMetrics, "inputTokens" | "outputTokens" | "unknownInputAttempts" | "unknownOutputAttempts">, price: TokenPrice): SpendEstimate {
  const usd = ((metrics.inputTokens ?? 0) * price.inputPerMillion + (metrics.outputTokens ?? 0) * price.outputPerMillion) / 1_000_000;
  return { usd: roundUsd(usd), exact: metrics.unknownInputAttempts === 0 && metrics.unknownOutputAttempts === 0 && metrics.inputTokens !== null && metrics.outputTokens !== null };
}

/** Round to micro-dollars so float noise never shows up in reports. */
export function roundUsd(usd: number): number {
  return Math.round(usd * 1e6) / 1e6;
}

/** Format a USD amount for reports. */
export function formatUsd(usd: number): string {
  return `$${usd > 0 && usd < 0.01 ? usd.toPrecision(2) : usd.toFixed(2)}`;
}
