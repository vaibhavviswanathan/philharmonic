import { useState, useEffect, useCallback } from 'react';

export interface SelectionRect {
  top: number;
  left: number;
  width: number;
  height: number;
}

export interface UseTextSelectionResult {
  hasSelection: boolean;
  selectionRect: SelectionRect | null;
  clearSelection: () => void;
}

export function useTextSelection(containerRef: React.RefObject<HTMLElement | null>): UseTextSelectionResult {
  const [hasSelection, setHasSelection] = useState(false);
  const [selectionRect, setSelectionRect] = useState<SelectionRect | null>(null);

  const update = useCallback(() => {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || sel.rangeCount === 0) {
      setHasSelection(false);
      setSelectionRect(null);
      return;
    }

    // Only show toolbar when selection is inside the container
    if (containerRef.current) {
      const node = sel.anchorNode;
      if (!containerRef.current.contains(node)) {
        setHasSelection(false);
        setSelectionRect(null);
        return;
      }
    }

    const range = sel.getRangeAt(0);
    const rect = range.getBoundingClientRect();
    if (rect.width === 0) {
      setHasSelection(false);
      setSelectionRect(null);
      return;
    }

    setHasSelection(true);
    setSelectionRect({
      top: rect.top + window.scrollY,
      left: rect.left + window.scrollX,
      width: rect.width,
      height: rect.height,
    });
  }, [containerRef]);

  useEffect(() => {
    document.addEventListener('selectionchange', update);
    return () => document.removeEventListener('selectionchange', update);
  }, [update]);

  const clearSelection = useCallback(() => {
    window.getSelection()?.removeAllRanges();
    setHasSelection(false);
    setSelectionRect(null);
  }, []);

  return { hasSelection, selectionRect, clearSelection };
}
