import { useState, useRef, useCallback } from 'react';

export interface UseDragAndDropOptions {
  onReorder: (fromIndex: number, toIndex: number) => void;
}

export function useDragAndDrop({ onReorder }: UseDragAndDropOptions) {
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [overId, setOverId] = useState<string | null>(null);
  const idToIndexRef = useRef<Map<string, number>>(new Map());

  const registerBlock = useCallback((id: string, index: number) => {
    idToIndexRef.current.set(id, index);
  }, []);

  const getDragHandleProps = useCallback(
    (id: string) => ({
      draggable: true,
      onDragStart: (e: React.DragEvent) => {
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', id);
        setDraggingId(id);
      },
      onDragEnd: () => {
        setDraggingId(null);
        setOverId(null);
      },
    }),
    []
  );

  const getDropZoneProps = useCallback(
    (id: string) => ({
      onDragOver: (e: React.DragEvent) => {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        setOverId(id);
      },
      onDragLeave: () => {
        setOverId((prev) => (prev === id ? null : prev));
      },
      onDrop: (e: React.DragEvent) => {
        e.preventDefault();
        const fromId = e.dataTransfer.getData('text/plain');
        const fromIndex = idToIndexRef.current.get(fromId);
        const toIndex = idToIndexRef.current.get(id);
        if (fromIndex !== undefined && toIndex !== undefined && fromIndex !== toIndex) {
          onReorder(fromIndex, toIndex);
        }
        setDraggingId(null);
        setOverId(null);
      },
    }),
    [onReorder]
  );

  return { draggingId, overId, registerBlock, getDragHandleProps, getDropZoneProps };
}
