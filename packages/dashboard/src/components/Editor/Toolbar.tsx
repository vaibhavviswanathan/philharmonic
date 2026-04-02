import React, { useEffect, useRef } from 'react';
import { applyFormat, isFormatActive, type FormatType } from '../../utils/textFormatting.js';
import { type SelectionRect } from '../../hooks/useTextSelection.js';

interface ToolbarProps {
  selectionRect: SelectionRect;
  onFormatApplied: () => void;
}

const TOOLBAR_HEIGHT = 36;
const TOOLBAR_WIDTH = 240;
const OFFSET = 8;

export function Toolbar({ selectionRect, onFormatApplied }: ToolbarProps) {
  const toolbarRef = useRef<HTMLDivElement>(null);

  const top = selectionRect.top - TOOLBAR_HEIGHT - OFFSET;
  const left = selectionRect.left + selectionRect.width / 2 - TOOLBAR_WIDTH / 2;

  const handleFormat = (format: FormatType) => (e: React.MouseEvent) => {
    e.preventDefault(); // don't steal focus
    applyFormat(format);
    onFormatApplied();
  };

  const isBold = isFormatActive('bold');
  const isItalic = isFormatActive('italic');

  return (
    <div
      ref={toolbarRef}
      className="editor-toolbar"
      style={{ top, left, width: TOOLBAR_WIDTH }}
      onMouseDown={(e) => e.preventDefault()} // keep selection alive
    >
      <button
        className={`editor-toolbar-btn${isBold ? ' active' : ''}`}
        onMouseDown={handleFormat('bold')}
        title="Bold (Ctrl+B)"
      >
        <strong>B</strong>
      </button>
      <button
        className={`editor-toolbar-btn${isItalic ? ' active' : ''}`}
        onMouseDown={handleFormat('italic')}
        title="Italic (Ctrl+I)"
      >
        <em>I</em>
      </button>
      <button
        className="editor-toolbar-btn"
        onMouseDown={handleFormat('code')}
        title="Inline code"
      >
        {'</>'}
      </button>
      <div className="editor-toolbar-divider" />
      <button
        className="editor-toolbar-btn"
        onMouseDown={handleFormat('link')}
        title="Link"
      >
        🔗
      </button>
    </div>
  );
}
