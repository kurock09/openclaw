// Per-request PersAI tool credential resolution for extensions.
// Allows plugins to read credentials from AsyncLocalStorage instead of process.env.

export { getPersaiToolCredential } from "../agents/persai-runtime-context.js";
