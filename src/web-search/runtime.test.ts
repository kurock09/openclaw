import { afterEach, describe, expect, it } from "vitest";
import { persaiRuntimeRequestContext } from "../agents/persai-runtime-context.js";
import type { OpenClawConfig } from "../config/config.js";
import { createEmptyPluginRegistry } from "../plugins/registry.js";
import { setActivePluginRegistry } from "../plugins/runtime.js";
import { runWebSearch } from "./runtime.js";

type TestPluginWebSearchConfig = {
  webSearch?: {
    apiKey?: unknown;
  };
};

describe("web search runtime", () => {
  afterEach(() => {
    setActivePluginRegistry(createEmptyPluginRegistry());
  });

  it("executes searches through the active plugin registry", async () => {
    const registry = createEmptyPluginRegistry();
    registry.webSearchProviders.push({
      pluginId: "custom-search",
      pluginName: "Custom Search",
      provider: {
        id: "custom",
        label: "Custom Search",
        hint: "Custom runtime provider",
        envVars: ["CUSTOM_SEARCH_API_KEY"],
        placeholder: "custom-...",
        signupUrl: "https://example.com/signup",
        credentialPath: "tools.web.search.custom.apiKey",
        autoDetectOrder: 1,
        getCredentialValue: () => "configured",
        setCredentialValue: () => {},
        createTool: () => ({
          description: "custom",
          parameters: {},
          execute: async (args) => ({ ...args, ok: true }),
        }),
      },
      source: "test",
    });
    setActivePluginRegistry(registry);

    await expect(
      runWebSearch({
        config: {},
        args: { query: "hello" },
      }),
    ).resolves.toEqual({
      provider: "custom",
      result: { query: "hello", ok: true },
    });
  });

  it("auto-detects a provider from canonical plugin-owned credentials", async () => {
    const registry = createEmptyPluginRegistry();
    registry.webSearchProviders.push({
      pluginId: "custom-search",
      pluginName: "Custom Search",
      provider: {
        id: "custom",
        label: "Custom Search",
        hint: "Custom runtime provider",
        envVars: ["CUSTOM_SEARCH_API_KEY"],
        placeholder: "custom-...",
        signupUrl: "https://example.com/signup",
        credentialPath: "plugins.entries.custom-search.config.webSearch.apiKey",
        autoDetectOrder: 1,
        getCredentialValue: () => undefined,
        setCredentialValue: () => {},
        getConfiguredCredentialValue: (config) => {
          const pluginConfig = config?.plugins?.entries?.["custom-search"]?.config as
            | TestPluginWebSearchConfig
            | undefined;
          return pluginConfig?.webSearch?.apiKey;
        },
        setConfiguredCredentialValue: (configTarget, value) => {
          configTarget.plugins = {
            ...configTarget.plugins,
            entries: {
              ...configTarget.plugins?.entries,
              "custom-search": {
                enabled: true,
                config: { webSearch: { apiKey: value } },
              },
            },
          };
        },
        createTool: () => ({
          description: "custom",
          parameters: {},
          execute: async (args) => ({ ...args, ok: true }),
        }),
      },
      source: "test",
    });
    setActivePluginRegistry(registry);

    const config: OpenClawConfig = {
      plugins: {
        entries: {
          "custom-search": {
            enabled: true,
            config: {
              webSearch: {
                apiKey: "custom-config-key",
              },
            },
          },
        },
      },
    };

    await expect(
      runWebSearch({
        config,
        args: { query: "hello" },
      }),
    ).resolves.toEqual({
      provider: "custom",
      result: { query: "hello", ok: true },
    });
  });

  it("prefers a credential-backed provider over stale runtime metadata", async () => {
    const registry = createEmptyPluginRegistry();
    registry.webSearchProviders.push({
      pluginId: "brave-search",
      pluginName: "Brave Search",
      provider: {
        id: "brave",
        label: "Brave Search",
        hint: "Brave runtime provider",
        envVars: ["BRAVE_API_KEY"],
        placeholder: "bsa-...",
        signupUrl: "https://example.com/brave",
        credentialPath: "plugins.entries.brave.config.webSearch.apiKey",
        autoDetectOrder: 1,
        getCredentialValue: () => undefined,
        setCredentialValue: () => {},
        createTool: () => ({
          description: "brave",
          parameters: {},
          execute: async (args) => ({ ...args, provider: "brave" }),
        }),
      },
      source: "test",
    });
    registry.webSearchProviders.push({
      pluginId: "tavily-search",
      pluginName: "Tavily Search",
      provider: {
        id: "tavily",
        label: "Tavily Search",
        hint: "Tavily runtime provider",
        envVars: ["TAVILY_API_KEY"],
        placeholder: "tvly-...",
        signupUrl: "https://example.com/tavily",
        credentialPath: "plugins.entries.tavily.config.webSearch.apiKey",
        autoDetectOrder: 2,
        getCredentialValue: () => undefined,
        setCredentialValue: () => {},
        createTool: () => ({
          description: "tavily",
          parameters: {},
          execute: async (args) => ({ ...args, provider: "tavily" }),
        }),
      },
      source: "test",
    });
    setActivePluginRegistry(registry);

    await expect(
      persaiRuntimeRequestContext.run(
        {
          toolCredentials: new Map([["TAVILY_API_KEY", "tvly-test-key"]]),
        },
        () =>
          runWebSearch({
            config: {},
            args: { query: "hello" },
            runtimeWebSearch: {
              providerConfigured: "brave",
              providerSource: "configured",
              selectedProvider: "brave",
              selectedProviderKeySource: "missing",
              diagnostics: [],
            },
          }),
      ),
    ).resolves.toEqual({
      provider: "tavily",
      result: { query: "hello", provider: "tavily" },
    });
  });
});
