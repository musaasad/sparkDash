/**
 * Loading shimmer. `SkeletonRows` mirrors the exact table geometry (36px rows,
 * 32px dense, hairline separators) so a loading table never jumps on resolve.
 */
export function Skeleton({ height = 14, width = "100%", style }: { height?: number; width?: number | string; style?: React.CSSProperties }) {
  return <div className="cp-skeleton" style={{ height, width, ...style }} />;
}

export function SkeletonRows({
  columns,
  rows = 5,
  dense = false,
}: {
  /** Column count — repeat a varied-width shimmer per cell. */
  columns: number;
  rows?: number;
  dense?: boolean;
}) {
  const widths = ["72%", "52%", "64%", "40%", "58%", "46%"];
  return (
    <div className="cp-skeleton-table" data-dense={dense || undefined} aria-hidden="true">
      {Array.from({ length: rows }).map((_, r) => (
        <div key={r} className="cp-skeleton-row">
          {Array.from({ length: columns }).map((__, c) => (
            <span key={c} className="cp-skeleton-cell">
              <Skeleton height={12} width={widths[(r + c) % widths.length]} />
            </span>
          ))}
        </div>
      ))}
    </div>
  );
}
