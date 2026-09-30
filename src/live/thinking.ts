import type { FetchLike, ProviderLoaderInput } from "../model/loader.ts";
import { isOpenRouterEndpoint, resolveThinkingSelection, validateThinking } from "../model/thinking.ts";

/** Discover only the selected route's reasoning evidence and refuse unadvertised choices before inference. */
export async function prepareSmokeThinking(input: ProviderLoaderInput, fetch: FetchLike, signal: AbortSignal): Promise<"unsupported_thinking" | "thinking_capability_unavailable" | undefined> {
  if (input.thinking === undefined) return;
  try {
    if (input.provider === "openai" && input.openaiAuth === "codex") {
      const { fetchSubscriptionCatalog } = await import("../model/providers/codex-subscription.ts");
      input.modelCapability = (await fetchSubscriptionCatalog({ store: input.codexStore!, fetch, signal })).find(entry => entry.id === input.model);
    } else if (input.provider === "xai") {
      const { fetchProviderModelList, requireXaiModels, xaiModelCapabilities } = await import("../model/model-list.ts");
      const models = input.xaiAuth === "grok"
        ? await (await import("../model/providers/grok-subscription.ts")).fetchSubscriptionModels({ store: input.grokStore!, fetch, signal })
        : requireXaiModels(await fetchProviderModelList({ url: (await import("../model/providers/xai.ts")).XAI_MODELS_URL, apiKey: input.apiKey, fetch, signal, label: "xAI" }));
      input.modelCapability = xaiModelCapabilities(models, input.xaiAuth === "grok" ? "grok" : "api-key").find(entry => entry.id === input.model);
    } else if (input.provider === "openai-compatible" && isOpenRouterEndpoint(input.baseUrl)) {
      const { fetchProviderModelList, openRouterModelCapabilities } = await import("../model/model-list.ts");
      const models = await fetchProviderModelList({ url: "https://openrouter.ai/api/v1/models", apiKey: input.apiKey, fetch, signal, label: "OpenRouter" });
      input.modelCapability = openRouterModelCapabilities(models).find(entry => entry.id === input.model);
    }
  } catch { return "thinking_capability_unavailable"; }
  const { context } = resolveThinkingSelection({ ...input, model: input.model!, capability: input.modelCapability });
  return validateThinking(context.provider, context.model, input.thinking, context.extraBody, context.capability, context.baseUrl, context.authRoute)
    ? "unsupported_thinking" : undefined;
}
