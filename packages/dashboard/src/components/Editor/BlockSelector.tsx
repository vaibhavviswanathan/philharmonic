import React, { useEffect, useRef, useState } from 'react';
import { type BlockType } from '../../types/editor.js';

interface BlockOption {
  type: BlockType;
  label: string;
  description: string;
  icon: string;
  level?: 1 | 2 | 3;
}

const BLOCK_OPTIONS: BlockOption[] = [
  { type: 'text', label: 'Text', description: 'Plain paragraph', icon: 'T' },
  { type: 'heading', label: 'Heading 1', description: 'Large heading', icon: 'H1', level: 1 },
  { type: 'heading', label: 'Heading 2', description: 'Medium heading', icon: 'H2', level: 2 },
  { type: 'heading', label: 'Heading 3', description: 'Small heading', icon: 'H3', level: 3 },
  { type: 'bullet', label: 'Bullet List', description: 'List with bullet points', icon: '•' },
  { type: 'code', label: 'Code', description: 'Code block', icon: '</>' },
];

interface BlockSelectorProps {
  onSelect: (type: BlockType, level?: 1 | 2 | 3) => void;
  onClose: () => void;
  position: { top: number; left: number };
}

export function BlockSelector({ onSelect, onClose, position }: BlockSelectorProps) {
  const [filter, setFilter] = useState('');
  const [activeIndex, setActiveIndex] = useState(0);
  const ref = useRef<HTMLDivElement>(null);

  const filtered = BLOCK_OPTIONS.filter(
    (o) =>
      o.label.toLowerCase().includes(filter.toLowerCase()) ||
      o.description.toLowerCase().includes(filter.toLowerCase())
  );

  useEffect(() => {
    setActiveIndex(0);
  }, [filter]);

  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setActiveIndex((i) => (i + 1) % filtered.length);
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        setActiveIndex((i) => (i - 1 + filtered.length) % filtered.length);
      } else if (e.key === 'Enter') {
        e.preventDefault();
        const opt = filtered[activeIndex];
        if (opt) onSelect(opt.type, opt.level);
      } else if (e.key === 'Escape') {
        onClose();
      }
    };
    document.addEventListener('keydown', handleKey);
    return () => document.removeEventListener('keydown', handleKey);
  }, [filtered, activeIndex, onSelect, onClose]);

  useEffect(() => {
    const handleClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        onClose();
      }
    };
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [onClose]);

  return (
    <div
      ref={ref}
      className="editor-block-selector"
      style={{ top: position.top, left: position.left }}
    >
      <div className="editor-block-selector-search">
        <input
          autoFocus
          className="editor-block-selector-input"
          placeholder="Search blocks..."
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
      </div>
      <div className="editor-block-selector-list">
        {filtered.length === 0 && (
          <div className="editor-block-selector-empty">No blocks found</div>
        )}
        {filtered.map((option, i) => (
          <button
            key={`${option.type}-${option.level ?? 0}`}
            className={`editor-block-selector-item${i === activeIndex ? ' active' : ''}`}
            onMouseDown={(e) => {
              e.preventDefault();
              onSelect(option.type, option.level);
            }}
            onMouseEnter={() => setActiveIndex(i)}
          >
            <span className="editor-block-selector-icon">{option.icon}</span>
            <div className="editor-block-selector-info">
              <span className="editor-block-selector-label">{option.label}</span>
              <span className="editor-block-selector-desc">{option.description}</span>
            </div>
          </button>
        ))}
      </div>
    </div>
  );
}
