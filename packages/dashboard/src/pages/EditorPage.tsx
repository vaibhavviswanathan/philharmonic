import React from 'react';
import { Editor } from '../components/Editor/Editor.js';

export function EditorPage({ onBack }: { onBack: () => void }) {
  return (
    <div className="min-h-screen">
      <div className="max-w-6xl mx-auto p-6">
        <div className="flex items-center gap-4 mb-6">
          <button
            onClick={onBack}
            className="text-sm text-gray-400 hover:text-white"
          >
            ← Back
          </button>
          <h2 className="text-lg font-semibold text-gray-200">Editor</h2>
        </div>
        <div className="bg-gray-900 rounded-xl border border-gray-800 min-h-[600px]">
          <Editor />
        </div>
      </div>
    </div>
  );
}
