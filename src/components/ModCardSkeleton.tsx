export function ModCardSkeleton() {
  return (
    <div className="mod-card-skeleton" aria-hidden="true">
      <div className="skeleton-cover">
        <span className="skeleton-line short" />
        <span className="skeleton-line tiny" />
      </div>
      <div className="skeleton-body">
        <span className="skeleton-line title" />
        <span className="skeleton-line meta" />
        <span className="skeleton-line text" />
        <span className="skeleton-line text shorter" />
      </div>
      <div className="skeleton-foot">
        <span className="skeleton-line tiny" />
        <span className="skeleton-pill" />
      </div>
    </div>
  );
}

export function BootSkeletonGrid() {
  return (
    <div className="boot-skeleton-grid" aria-hidden="true">
      {Array.from({ length: 6 }, (_, index) => (
        <ModCardSkeleton key={index} />
      ))}
    </div>
  );
}
