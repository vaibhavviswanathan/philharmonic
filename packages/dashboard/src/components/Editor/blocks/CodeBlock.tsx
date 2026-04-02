import React, { useRef, useEffect } from 'react';

interface CodeBlockProps {
  content: string;
  language: string;
  onChange: (content: string) => void;
  onLanguageChange: (language: string) => void;
  onEnter: () => void;
  onBackspaceEmpty: () => void;
  focused: boolean;
}

export function CodeBlock({ content, language, onChange, onLanguageChange, onEnter, onBackspaceEmpty, focused }: CodeBlockProps) {
  const ref = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (focused && ref.current) {
      ref.current.focus();
    }
  }, [focused]);

  const handleChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    onChange(e.target.value);
    // Auto-resize
    e.target.style.height = 'auto';
    e.target.style.height = e.target.scrollHeight + 'px';
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Tab') {
      e.preventDefault();
      const ta = ref.current!;
      const start = ta.selectionStart;
      const end = ta.selectionEnd;
      const newVal = content.substring(0, start) + '  ' + content.substring(end);
      onChange(newVal);
      requestAnimationFrame(() => {
        ta.selectionStart = ta.selectionEnd = start + 2;
      });
    } else if (e.key === 'Backspace' && content === '') {
      e.preventDefault();
      onBackspaceEmpty();
    } else if (e.key === 'Enter' && e.metaKey) {
      e.preventDefault();
      onEnter();
    }
  };

  return (
    <div className="editor-block-code">
      <div className="editor-code-header">
        <input
          className="editor-code-lang"
          value={language}
          onChange={(e) => onLanguageChange(e.target.value)}
          placeholder="Language"
          spellCheck={false}
        />
      </div>
      <textarea
        ref={ref}
        className="editor-code-textarea"
        value={content}
        onChange={handleChange}
        onKeyDown={handleKeyDown}
        spellCheck={false}
        rows={Math.max(3, content.split('\n').length)}
        placeholder="// Write code here..."
      />
    </div>
  );
}
