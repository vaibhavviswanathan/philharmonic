import { useEffect, useState } from "react";
import { getSettings, updateSettings, type Settings } from "../api.js";

export function SettingsPanel({ onBack }: { onBack: () => void }) {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [anthropicKey, setAnthropicKey] = useState("");
  const [githubToken, setGithubToken] = useState("");
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");

  useEffect(() => {
    getSettings().then((s) => {
      setSettings(s);
    }).catch((err) => setMessage(`Error loading settings: ${err}`));
  }, []);

  async function handleSave() {
    setSaving(true);
    setMessage("");
    try {
      const updates: Record<string, string> = {};
      if (anthropicKey) updates.anthropicApiKey = anthropicKey;
      if (githubToken) updates.githubToken = githubToken;
      await updateSettings(updates);
      setAnthropicKey("");
      setGithubToken("");
      const s = await getSettings();
      setSettings(s);
      setMessage("Settings saved.");
    } catch (err) {
      setMessage(`Error: ${err}`);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-4">
      <button onClick={onBack} className="text-sm text-gray-400 hover:text-white">
        &larr; Back
      </button>

      <div className="p-4 bg-gray-900 rounded-lg border border-gray-800 space-y-4">
        <h2 className="text-lg font-semibold">Settings</h2>
        <p className="text-sm text-gray-400">
          Configure API tokens. These are stored in your Cloudflare Durable Object and override environment variables.
        </p>

        <div className="space-y-3">
          <div>
            <label className="block text-sm font-medium mb-1">Anthropic API Key</label>
            {settings?.anthropicApiKey ? (
              <p className="text-xs text-green-400 mb-1">Configured via UI</p>
            ) : settings?.envAnthropicApiKey ? (
              <p className="text-xs text-blue-400 mb-1">Set via environment variable</p>
            ) : (
              <p className="text-xs text-red-400 mb-1">Not configured</p>
            )}
            <input
              type="password"
              placeholder="sk-ant-..."
              value={anthropicKey}
              onChange={(e) => setAnthropicKey(e.target.value)}
              className="w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded text-sm focus:outline-none focus:border-blue-500"
            />
          </div>

          <div>
            <label className="block text-sm font-medium mb-1">GitHub Token</label>
            {settings?.githubToken ? (
              <p className="text-xs text-green-400 mb-1">Configured via UI</p>
            ) : settings?.envGithubToken ? (
              <p className="text-xs text-blue-400 mb-1">Set via environment variable</p>
            ) : (
              <p className="text-xs text-red-400 mb-1">Not configured</p>
            )}
            <input
              type="password"
              placeholder="ghp_..."
              value={githubToken}
              onChange={(e) => setGithubToken(e.target.value)}
              className="w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded text-sm focus:outline-none focus:border-blue-500"
            />
            <p className="text-xs text-gray-500 mt-1">Needs repo scope (clone, push, create PRs)</p>
          </div>
        </div>

        {message && (
          <p className={`text-sm ${message.startsWith("Error") ? "text-red-400" : "text-green-400"}`}>
            {message}
          </p>
        )}

        <button
          onClick={handleSave}
          disabled={saving || (!anthropicKey && !githubToken)}
          className="px-4 py-2 bg-blue-600 hover:bg-blue-700 disabled:opacity-50 rounded text-sm font-medium"
        >
          {saving ? "Saving..." : "Save"}
        </button>
      </div>
    </div>
  );
}
