export function FileIcon({
  folder = false,
  open = false,
}: {
  folder?: boolean;
  open?: boolean;
}) {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24">
      {folder ? (
        <path
          d={
            open
              ? "M3 9V5h6l3 3h9v3M3 11h19l-3 9H5l-2-9Z"
              : "M3 6h6l3 3h9v11H3V6Z"
          }
        />
      ) : (
        <>
          <path d="M6 3h8l4 4v14H6V3Z" />
          <path d="M14 3v5h4M9 12h6m-6 4h6" />
        </>
      )}
    </svg>
  );
}
