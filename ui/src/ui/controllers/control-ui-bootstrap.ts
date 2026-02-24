import {
  CONTROL_UI_BOOTSTRAP_CONFIG_PATH,
  type ControlUiBootstrapConfig,
} from "../../../../src/gateway/control-ui-contract.js";
import { normalizeAssistantIdentity } from "../assistant-identity.ts";
import { normalizeBasePath } from "../navigation.ts";
import type { UiSettings } from "../storage.ts";

export type ControlUiBootstrapState = {
  basePath: string;
  assistantName: string;
  assistantAvatar: string | null;
  assistantAgentId: string | null;
  settings?: UiSettings;
  applySettings?: (next: UiSettings) => void;
};

function resolveDefaultGatewayUrl(): string | null {
  if (typeof window === "undefined") {
    return null;
  }
  const proto = window.location.protocol === "https:" ? "wss" : "ws";
  return `${proto}://${window.location.host}`;
}

function maybeApplyGatewayToken(
  state: ControlUiBootstrapState,
  token: string | undefined,
  source: string | undefined,
): boolean {
  const nextToken = token?.trim();
  const settings = state.settings;
  if (!settings) {
    return false;
  }
  if (typeof state.applySettings !== "function") {
    return false;
  }
  let nextSettings = settings;
  let changed = false;
  if (nextToken && nextToken !== settings.token.trim()) {
    nextSettings = { ...nextSettings, token: nextToken };
    changed = true;
  }
  if (source === "loopback") {
    const expectedGatewayUrl = resolveDefaultGatewayUrl();
    const currentUrl = nextSettings.gatewayUrl.trim();
    if (expectedGatewayUrl && (!currentUrl || currentUrl !== expectedGatewayUrl)) {
      nextSettings = { ...nextSettings, gatewayUrl: expectedGatewayUrl };
      changed = true;
    }
  }
  if (!changed) {
    return false;
  }
  state.applySettings(nextSettings);
  return true;
}

export async function loadControlUiBootstrapConfig(
  state: ControlUiBootstrapState,
): Promise<boolean> {
  if (typeof window === "undefined") {
    return false;
  }
  if (typeof fetch !== "function") {
    return false;
  }

  const basePath = normalizeBasePath(state.basePath ?? "");
  const url = basePath
    ? `${basePath}${CONTROL_UI_BOOTSTRAP_CONFIG_PATH}`
    : CONTROL_UI_BOOTSTRAP_CONFIG_PATH;

  try {
    const res = await fetch(url, {
      method: "GET",
      headers: { Accept: "application/json" },
      credentials: "same-origin",
    });
    if (!res.ok) {
      return false;
    }
    const parsed = (await res.json()) as ControlUiBootstrapConfig;
    const normalized = normalizeAssistantIdentity({
      agentId: parsed.assistantAgentId ?? null,
      name: parsed.assistantName,
      avatar: parsed.assistantAvatar ?? null,
    });
    state.assistantName = normalized.name;
    state.assistantAvatar = normalized.avatar;
    state.assistantAgentId = normalized.agentId ?? null;
    return maybeApplyGatewayToken(state, parsed.gatewayToken, parsed.gatewayTokenSource);
  } catch {
    // Ignore bootstrap failures; UI will update identity after connecting.
    return false;
  }
}
