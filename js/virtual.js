// Windowed lists so a few thousand songs don't build thousands of DOM nodes.
export function createVirtual({ scrollEl, host, getMetrics, renderItem, overscan = 5 }) {
  let lastKey = '';
  let raf = 0;

  function paint() {
    const m = getMetrics();
    const cols = Math.max(1, m.cols | 0);
    const rowH = m.rowHeight;
    const count = m.count | 0;
    const rows = Math.ceil(count / cols);
    host.style.height = `${rows * rowH}px`;
    if (!count) {
      host.replaceChildren();
      lastKey = '';
      return;
    }
    const scrollRect = scrollEl.getBoundingClientRect();
    const hostRect = host.getBoundingClientRect();
    const hostTop = hostRect.top - scrollRect.top + scrollEl.scrollTop;
    const viewTop = scrollEl.scrollTop - hostTop;
    let start = Math.floor(viewTop / rowH) - overscan;
    if (start < 0) start = 0;
    const viewH = scrollEl.clientHeight || 600;
    let end = Math.ceil((viewTop + viewH) / rowH) + overscan;
    if (end > rows) end = rows;
    if (end < start) end = start;
    const key = `${start}:${end}:${cols}:${rowH}:${m.stamp || ''}`;
    if (key === lastKey) return;
    lastKey = key;
    const win = document.createElement('div');
    win.className = 'vwin';
    win.style.transform = `translateY(${start * rowH}px)`;
    const frag = document.createDocumentFragment();
    for (let r = start; r < end; r++) {
      const row = document.createElement('div');
      row.className = 'vrow';
      row.style.height = `${rowH}px`;
      row.style.setProperty('--cols', String(cols));
      for (let c = 0; c < cols; c++) {
        const i = r * cols + c;
        if (i >= count) break;
        const cell = document.createElement('div');
        cell.className = 'cell';
        cell.innerHTML = renderItem(i);
        row.appendChild(cell);
      }
      frag.appendChild(row);
    }
    win.appendChild(frag);
    host.replaceChildren(win);
    if (m.onPaint) m.onPaint(host);
  }

  function schedule() {
    cancelAnimationFrame(raf);
    raf = requestAnimationFrame(paint);
  }

  const onScroll = () => schedule();
  scrollEl.addEventListener('scroll', onScroll, { passive: true });
  schedule();

  return {
    paint() {
      lastKey = '';
      schedule();
    },
    destroy() {
      cancelAnimationFrame(raf);
      scrollEl.removeEventListener('scroll', onScroll);
    },
  };
}
