import React, { useRef, useEffect } from 'react';

interface HeadingBlockProps {
  content: string;
  level: 1 | 2 | 3;
  onChange: (content: string) => void;
  onEnter: () => void;
  onBackspaceEmpty: () => void;
  focused: boolean;
}

export function HeadingBlock({ content, level, onChange, onEnter, onBackspaceEmpty, focused }: HeadingBlockProps) {
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

  const Tag = `h${level}` as 'h1' | 'h2' | 'h3';
  const className = level === 1
    ? 'editor-block-h1'
    : level === 2
    ? 'editor-block-h2'
    : 'editor-block-h3';

  return (
    <Tag
      ref={ref as React.Ref<HTMLHeadingElement>}
      className={className}
      contentEditable
      suppressContentEditableWarning
      onInput={handleInput}
      onKeyDown={handleKeyDown}
      dangerouslySetInnerHTML={{ __html: content }}
      data-placeholder={`Heading ${level}`}
    />
  );
}
