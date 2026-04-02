import React, { useEffect } from 'react';
import { type Block as BlockType } from '../../types/editor.js';
import { TextBlock } from './blocks/TextBlock.js';
import { HeadingBlock } from './blocks/HeadingBlock.js';
import { BulletListBlock } from './blocks/BulletListBlock.js';
import { CodeBlock } from './blocks/CodeBlock.js';

interface BlockProps {
  block: BlockType;
  index: number;
  focused: boolean;
  isDragging: boolean;
  isOver: boolean;
  dragHandleProps: React.HTMLAttributes<HTMLDivElement>;
  dropZoneProps: React.HTMLAttributes<HTMLDivElement>;
  onRegister: (id: string, index: number) => void;
  onChange: (id: string, content: string) => void;
  onLanguageChange: (id: string, language: string) => void;
  onEnter: (id: string) => void;
  onBackspaceEmpty: (id: string) => void;
  onFocus: (id: string) => void;
}

export function Block({
  block,
  index,
  focused,
  isDragging,
  isOver,
  dragHandleProps,
  dropZoneProps,
  onRegister,
  onChange,
  onLanguageChange,
  onEnter,
  onBackspaceEmpty,
  onFocus,
}: BlockProps) {
  useEffect(() => {
    onRegister(block.id, index);
  }, [block.id, index, onRegister]);

  const renderBlockContent = () => {
    switch (block.type) {
      case 'text':
        return (
          <TextBlock
            content={block.content}
            focused={focused}
            onChange={(c) => onChange(block.id, c)}
            onEnter={() => onEnter(block.id)}
            onBackspaceEmpty={() => onBackspaceEmpty(block.id)}
          />
        );
      case 'heading':
        return (
          <HeadingBlock
            content={block.content}
            level={block.level ?? 1}
            focused={focused}
            onChange={(c) => onChange(block.id, c)}
            onEnter={() => onEnter(block.id)}
            onBackspaceEmpty={() => onBackspaceEmpty(block.id)}
          />
        );
      case 'bullet':
        return (
          <BulletListBlock
            content={block.content}
            focused={focused}
            onChange={(c) => onChange(block.id, c)}
            onEnter={() => onEnter(block.id)}
            onBackspaceEmpty={() => onBackspaceEmpty(block.id)}
          />
        );
      case 'code':
        return (
          <CodeBlock
            content={block.content}
            language={block.language ?? 'plaintext'}
            focused={focused}
            onChange={(c) => onChange(block.id, c)}
            onLanguageChange={(l) => onLanguageChange(block.id, l)}
            onEnter={() => onEnter(block.id)}
            onBackspaceEmpty={() => onBackspaceEmpty(block.id)}
          />
        );
    }
  };

  return (
    <div
      className={[
        'editor-block',
        isDragging ? 'dragging' : '',
        isOver ? 'drag-over' : '',
      ].join(' ')}
      onClick={() => onFocus(block.id)}
      {...dropZoneProps}
    >
      <div
        className="editor-block-handle"
        title="Drag to reorder"
        {...dragHandleProps}
      >
        ⠿
      </div>
      <div className="editor-block-content">{renderBlockContent()}</div>
    </div>
  );
}
