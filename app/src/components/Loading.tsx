export function Loading({ text }: { text?: string }) {
  return (
    <div className="center">
      <span className="spinner" />
      {text ? <span>{text}</span> : null}
    </div>
  );
}
