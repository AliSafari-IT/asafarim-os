/** The result of the last action (`?notice=` or `?error=`), announced to assistive tech. */
export function Flash({ notice, error }: { notice?: string; error?: string }) {
  if (error) {
    return (
      <div className="notice bad" role="alert" data-testid="flash-error">
        {error}
      </div>
    );
  }
  if (notice) {
    return (
      <div className="notice" role="status" data-testid="flash-notice">
        {notice}
      </div>
    );
  }
  return null;
}
