export type FormatType = 'bold' | 'italic' | 'code' | 'link';

export function applyFormat(format: FormatType, url?: string): void {
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed || sel.rangeCount === 0) return;

  document.execCommand('styleWithCSS', false, 'false');

  switch (format) {
    case 'bold':
      document.execCommand('bold', false);
      break;
    case 'italic':
      document.execCommand('italic', false);
      break;
    case 'code': {
      const range = sel.getRangeAt(0);
      const selectedText = range.toString();
      if (!selectedText) return;
      const code = document.createElement('code');
      code.className = 'editor-inline-code';
      code.textContent = selectedText;
      range.deleteContents();
      range.insertNode(code);
      // Move selection after the code element
      const newRange = document.createRange();
      newRange.setStartAfter(code);
      newRange.collapse(true);
      sel.removeAllRanges();
      sel.addRange(newRange);
      break;
    }
    case 'link': {
      const href = url ?? prompt('Enter URL:');
      if (href) {
        document.execCommand('createLink', false, href);
        // Style the link
        const links = document.querySelectorAll('a:not([class])');
        links.forEach((link) => link.classList.add('editor-link'));
      }
      break;
    }
  }
}

export function isFormatActive(format: 'bold' | 'italic'): boolean {
  return document.queryCommandState(format);
}
