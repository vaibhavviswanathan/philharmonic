import { useState } from "react";
import { createProject } from "../api.js";

export function NewProjectForm({ onCreated }: { onCreated: () => void }) {
  const [name, setName] = useState("");
  const [repoUrl, setRepoUrl] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError("");
    try {
      await createProject(name, repoUrl);
      setName("");
      setRepoUrl("");
      onCreated();
    } catch (err) {
      setError(String(err));
    } finally {
      setLoading(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="notion-panel p-5 space-y-4">
      <h3 className="text-sm font-semibold text-[#e5e5e5]">New Project</h3>
      <div className="space-y-3">
        <input
          type="text"
          placeholder="Project name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          required
          className="notion-input"
        />
        <input
          type="url"
          placeholder="https://github.com/org/repo"
          value={repoUrl}
          onChange={(e) => setRepoUrl(e.target.value)}
          required
          className="notion-input"
        />
      </div>
      {error && <p className="text-red-400 text-xs">{error}</p>}
      <button type="submit" disabled={loading} className="notion-btn-primary">
        {loading ? "Creating..." : "Create project"}
      </button>
    </form>
  );
}
