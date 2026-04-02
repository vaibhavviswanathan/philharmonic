import React, { useRef, useEffect } from 'react';

interface BulletListBlockProps {
  content: string;
  onChange: (content: string) => void;
  onEnter: () => void;
  onBackspaceEmpty: () => void;
  focused: boolean;
}

export function BulletListBlock({ content, onChange, onEnter, onBackspaceEmpty, focused }: BulletListBlockProps) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (focused && ref.current) {
      ref.current.focus();
      const range = document.createRange();
      const sel = window.getSelection();
      range.selectNodeContents(ref.current);
      range.collapse(false);
      sel?.removeAllRanges();
      sel?.addRange(range);
    }
  }, [focused]);

  const handleInput = () => {
    if (ref.current) {
      onChange(ref.current.innerHTML);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      onEnter();
    } else if (e.key === 'Backspace' && content === '') {
      e.preventDefault();
      onBackspaceEmpty();
    }
  };

  return (
    <div className="editor-block-bullet">
      <span className="editor-bullet-dot">•</span>
      <div
        ref={ref}
        className="editor-bullet-content"
        contentEditable
        suppressContentEditableWarning
        onInput={handleInput}
        onKeyDown={handleKeyDown}
        dangerouslySetInnerHTML={{ __html: content }}
        data-placeholder="List item"
      />
    </div>
  );
}
