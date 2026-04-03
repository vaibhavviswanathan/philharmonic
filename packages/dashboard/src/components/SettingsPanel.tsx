import { useEffect, useState } from "react";
import { getSettings, updateSettings, type Settings } from "../api.js";

export function SettingsPanel({ onBack }: { onBack: () => void }) {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [anthropicKey, setAnthropicKey] = useState("");
  const [githubToken, setGithubToken] = useState("");
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");

  useEffect(() => {
    getSettings()
      .then((s) => setSettings(s))
      .catch((err) => setMessage(`Error loading settings: ${err}`));
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
    <div className="max-w-2xl mx-auto px-10 py-12">
      {/* Breadcrumb */}
      <div className="flex items-center gap-2 text-xs text-[#555] mb-6">
        <button onClick={onBack} className="hover:text-[#999] transition-colors">
          Home
        </button>
        <span>/</span>
        <span className="text-[#999]">Settings</span>
      </div>

      {/* Page header */}
      <div className="mb-8">
        <div className="text-4xl mb-3">⚙️</div>
        <h1 className="text-3xl font-bold text-[#e5e5e5] tracking-tight">Settings</h1>
        <p className="text-[#666] text-sm mt-1">
          Configure API tokens — stored in Cloudflare Durable Object, override env variables.
        </p>
      </div>

      {/* Fields */}
      <div className="notion-panel p-6 space-y-6">
        <div>
          <div className="flex items-center justify-between mb-1">
            <label className="text-sm font-medium text-[#e5e5e5]">Anthropic API Key</label>
            <StatusChip
              uiSet={!!settings?.anthropicApiKey}
              envSet={!!settings?.envAnthropicApiKey}
            />
          </div>
          <input
            type="password"
            placeholder="sk-ant-..."
            value={anthropicKey}
            onChange={(e) => setAnthropicKey(e.target.value)}
            className="notion-input mt-2"
          />
        </div>

        <div className="border-t border-[#3d3d3d] pt-6">
          <div className="flex items-center justify-between mb-1">
            <label className="text-sm font-medium text-[#e5e5e5]">GitHub Token</label>
            <StatusChip
              uiSet={!!settings?.githubToken}
              envSet={!!settings?.envGithubToken}
            />
          </div>
          <input
            type="password"
            placeholder="ghp_..."
            value={githubToken}
            onChange={(e) => setGithubToken(e.target.value)}
            className="notion-input mt-2"
          />
          <p className="text-xs text-[#555] mt-2">Needs repo scope (clone, push, create PRs)</p>
        </div>

        {message && (
          <p className={`text-sm ${message.startsWith("Error") ? "text-red-400" : "text-green-400"}`}>
            {message}
          </p>
        )}

        <button
          onClick={handleSave}
          disabled={saving || (!anthropicKey && !githubToken)}
          className="notion-btn-primary"
        >
          {saving ? "Saving..." : "Save changes"}
        </button>
      </div>
    </div>
  );
}

function StatusChip({
  uiSet,
  envSet,
}: {
  uiSet: boolean;
  envSet: boolean;
}) {
  if (uiSet) {
    return <span className="text-[10px] font-medium text-green-400 bg-green-500/10 px-2 py-0.5 rounded-full">configured</span>;
  }
  if (envSet) {
    return <span className="text-[10px] font-medium text-blue-400 bg-blue-500/10 px-2 py-0.5 rounded-full">via env</span>;
  }
  return <span className="text-[10px] font-medium text-red-400 bg-red-500/10 px-2 py-0.5 rounded-full">not set</span>;
}
