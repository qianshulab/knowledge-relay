type BrandProps = {
  compact?: boolean;
  inverse?: boolean;
  showDescriptor?: boolean;
};

export default function Brand({ compact = false, inverse = false, showDescriptor = true }: BrandProps) {
  return (
    <span className={`brand ${compact ? "brand-compact" : ""} ${inverse ? "brand-inverse" : ""}`}>
      <span className="brand-symbol" aria-hidden="true">
        <img src="/app/favicon.svg?v=20260905" alt="" width="42" height="42" />
      </span>
      {!compact && (
        <span className="brand-wordmark">
          <strong>知流</strong>
          {showDescriptor && <small>Knowledge Relay</small>}
        </span>
      )}
    </span>
  );
}
