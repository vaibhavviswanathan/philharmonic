export type BlockType = 'text' | 'heading' | 'bullet' | 'code';

export interface Block {
  id: string;
  type: BlockType;
  content: string;
  level?: 1 | 2 | 3;
  language?: string;
}

export interface EditorState {
  blocks: Block[];
  selectedBlockId: string | null;
}

export interface DragState {
  draggingId: string | null;
  overId: string | null;
}
