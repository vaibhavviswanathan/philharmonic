import React, { useRef, useEffect } from 'react';

interface TextBlockProps {
  content: string;
  onChange: (content: string) => void;
  onEnter: () => void;
  onBackspaceEmpty: () => void;
  focused: boolean;
}

export function TextBlock({ content, onChange, onEnter, onBackspaceEmpty, focused }: TextBlockProps) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (focused && ref.current) {
      ref.current.focus();
      // Place cursor at end
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
    <div
      ref={ref}
      className="editor-block-text"
      contentEditable
      suppressContentEditableWarning
      onInput={handleInput}
      onKeyDown={handleKeyDown}
      dangerouslySetInnerHTML={{ __html: content }}
      data-placeholder="Type something..."
    />
  );
}
