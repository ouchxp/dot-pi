import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";

// Apply OpenAI priority service tier only to the requests of the models
// listed below. All other models stream unchanged.
//
// The tier is injected through the global before_provider_request hook (which
// can replace the outgoing request body) rather than a per-provider
// streamSimple wrapper: the hook fires for every provider request, so any
// 3rd-party OpenAI-compatible provider hosting a tiered model is covered
// without registering under each provider id.
const TIERED_MODEL_IDS = ["gpt-5.6-luna"];
const SERVICE_TIER = "priority";
const STATUS_KEY = "openai-service-tier";

function isPriorityModel(model: { id: string } | undefined): boolean {
  return model ? TIERED_MODEL_IDS.includes(model.id) : false;
}

export default function openaiServiceTier(pi: ExtensionAPI): void {
  pi.on("before_provider_request", (event) => {
    const payload = event.payload as { model?: string } | undefined;
    if (!payload || typeof payload.model !== "string") return;
    if (!isPriorityModel({ id: payload.model })) return;
    return { ...payload, service_tier: SERVICE_TIER };
  });

  const updateStatus = (ctx: ExtensionContext) => {
    ctx.ui.setStatus(
      STATUS_KEY,
      ctx.model && isPriorityModel(ctx.model)
        ? `${ctx.model.id} ${SERVICE_TIER}`
        : undefined,
    );
  };
  pi.on("session_start", (_event, ctx) => updateStatus(ctx));
  pi.on("model_select", (_event, ctx) => updateStatus(ctx));
  pi.on("session_shutdown", (_event, ctx) =>
    ctx.ui.setStatus(STATUS_KEY, undefined),
  );
}
