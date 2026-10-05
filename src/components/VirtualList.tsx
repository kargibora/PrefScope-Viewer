import React, { useCallback, useEffect, useRef, useState } from "react";

/**
 * Windowed list: renders only the rows intersecting the viewport plus an overscan
 * margin, so a 2048-concept list costs the same DOM as a 20-concept one.
 *
 * Rows are fixed height, which keeps offset maths exact and avoids a measurement pass.
 */
export function VirtualList<T>({
  items,
  rowHeight,
  height,
  renderRow,
  overscan = 6,
  className = "",
  emptyMessage = "Nothing to show.",
}: {
  items: T[];
  rowHeight: number;
  height: number;
  renderRow: (item: T, index: number) => React.ReactNode;
  overscan?: number;
  className?: string;
  emptyMessage?: string;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [scrollTop, setScrollTop] = useState(0);

  const onScroll = useCallback(() => {
    if (ref.current) setScrollTop(ref.current.scrollTop);
  }, []);

  // A filter change can leave the window scrolled past the new end.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const max = Math.max(0, items.length * rowHeight - height);
    if (el.scrollTop > max) {
      el.scrollTop = max;
      setScrollTop(max);
    }
  }, [items.length, rowHeight, height]);

  if (items.length === 0) {
    return <div className={`text-sm text-slate-500 px-1 py-6 ${className}`}>{emptyMessage}</div>;
  }

  const total = items.length * rowHeight;
  const first = Math.max(0, Math.floor(scrollTop / rowHeight) - overscan);
  const visible = Math.ceil(height / rowHeight) + overscan * 2;
  const last = Math.min(items.length, first + visible);
  const slice = items.slice(first, last);

  return (
    <div
      ref={ref}
      onScroll={onScroll}
      className={`overflow-y-auto ${className}`}
      style={{ height }}
      role="list"
    >
      <div style={{ height: total, position: "relative" }}>
        <div style={{ position: "absolute", top: first * rowHeight, left: 0, right: 0 }}>
          {slice.map((item, i) => (
            <div key={first + i} style={{ height: rowHeight }} role="listitem">
              {renderRow(item, first + i)}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

/** Min/max without spreading into call arguments, which overflows the stack past ~65k. */
export function extent(values: ArrayLike<number>): [number, number] {
  let lo = Infinity;
  let hi = -Infinity;
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  return lo === Infinity ? [0, 1] : [lo, hi];
}
