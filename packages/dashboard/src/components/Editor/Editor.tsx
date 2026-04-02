import React, { useCallback, useRef, useState } from 'react';
import { type Block as BlockData, type BlockType } from '../../types/editor.js';
import { useDragAndDrop } from '../../hooks/useDragAndDrop.js';
import { useTextSelection } from '../../hooks/useTextSelection.js';
import { Block } from './Block.js';
import { BlockSelector } from './BlockSelector.js';
import { Toolbar } from './Toolbar.js';
import './Editor.css';

function generateId(): string {
  return Math.random().toString(36).slice(2, 10);
}

function makeBlock(type: BlockType, level?: 1 | 2 | 3): BlockData {
  return {
    id: generateId(),
    type,
    content: '',
    level: type === 'heading' ? (level ?? 1) : undefined,
    language: type === 'code' ? 'plaintext' : undefined,
  };
}

interface BlockSelectorState {
  blockId: string;
  position: { top: number; left: number };
}

export function Editor() {
  const [blocks, setBlocks] = useState<BlockData[]>([makeBlock('text')]);
  const [focusedId, setFocusedId] = useState<string | null>(blocks[0].id);
  const [blockSelector, setBlockSelector] = useState<BlockSelectorState | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  const { hasSelection, selectionRect } = useTextSelection(containerRef);

  const reorder = useCallback((fromIndex: number, toIndex: number) => {
    setBlocks((prev) => {
      const next = [...prev];
      const [moved] = next.splice(fromIndex, 1);
      next.splice(toIndex, 0, moved);
      return next;
    });
  }, []);

  const { draggingId, overId, registerBlock, getDragHandleProps, getDropZoneProps } =
    useDragAndDrop({ onReorder: reorder });

  const handleChange = useCallback((id: string, content: string) => {
    setBlocks((prev) =>
      prev.map((b) => (b.id === id ? { ...b, content } : b))
    );
    // Trigger block selector on "/"
    if (content === '/' || content === '<div>/</div>') {
      const el = document.querySelector(`[data-block-id="${id}"]`);
      if (el) {
        const rect = el.getBoundingClientRect();
        setBlockSelector({
          blockId: id,
          position: { top: rect.bottom + window.scrollY + 4, left: rect.left + window.scrollX },
        });
      }
    }
  }, []);

  const handleLanguageChange = useCallback((id: string, language: string) => {
    setBlocks((prev) =>
      prev.map((b) => (b.id === id ? { ...b, language } : b))
    );
  }, []);

  const handleEnter = useCallback((id: string) => {
    const newBlock = makeBlock('text');
    setBlocks((prev) => {
      const idx = prev.findIndex((b) => b.id === id);
      const next = [...prev];
      next.splice(idx + 1, 0, newBlock);
      return next;
    });
    setFocusedId(newBlock.id);
  }, []);

  const handleBackspaceEmpty = useCallback((id: string) => {
    setBlocks((prev) => {
      if (prev.length === 1) return prev;
      const idx = prev.findIndex((b) => b.id === id);
      const next = prev.filter((b) => b.id !== id);
      const newFocusIdx = Math.max(0, idx - 1);
      setFocusedId(next[newFocusIdx]?.id ?? null);
      return next;
    });
  }, []);

  const handleBlockSelectorSelect = useCallback(
    (type: BlockType, level?: 1 | 2 | 3) => {
      if (!blockSelector) return;
      const { blockId } = blockSelector;
      setBlocks((prev) =>
        prev.map((b) =>
          b.id === blockId
            ? { ...b, type, content: '', level: type === 'heading' ? level : undefined, language: type === 'code' ? 'plaintext' : undefined }
            : b
        )
      );
      setFocusedId(blockId);
      setBlockSelector(null);
    },
    [blockSelector]
  );

  const addBlock = () => {
    const newBlock = makeBlock('text');
    setBlocks((prev) => [...prev, newBlock]);
    setFocusedId(newBlock.id);
  };

  return (
    <div className="editor-root">
      <div className="editor-container" ref={containerRef}>
        {blocks.map((block, index) => (
          <div key={block.id} data-block-id={block.id}>
            <Block
              block={block}
              index={index}
              focused={focusedId === block.id}
              isDragging={draggingId === block.id}
              isOver={overId === block.id}
              dragHandleProps={getDragHandleProps(block.id) as React.HTMLAttributes<HTMLDivElement>}
              dropZoneProps={getDropZoneProps(block.id) as React.HTMLAttributes<HTMLDivElement>}
              onRegister={registerBlock}
              onChange={handleChange}
              onLanguageChange={handleLanguageChange}
              onEnter={handleEnter}
              onBackspaceEmpty={handleBackspaceEmpty}
              onFocus={setFocusedId}
            />
          </div>
        ))}
        <button className="editor-add-block" onClick={addBlock}>
          + Add block
        </button>
      </div>

      {blockSelector && (
        <BlockSelector
          position={blockSelector.position}
          onSelect={handleBlockSelectorSelect}
          onClose={() => setBlockSelector(null)}
        />
      )}

      {hasSelection && selectionRect && (
        <Toolbar
          selectionRect={selectionRect}
          onFormatApplied={() => {}}
        />
      )}
    </div>
  );
}
