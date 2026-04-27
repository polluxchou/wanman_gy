interface ErrorBannerProps {
  error: unknown;
  title?: string;
}

export function ErrorBanner({ error, title = 'Could not load data' }: ErrorBannerProps) {
  const message =
    error instanceof Error
      ? error.message
      : typeof error === 'string'
        ? error
        : 'Unknown error';

  return (
    <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm">
      <p className="font-medium text-red-700">{title}</p>
      <p className="mt-0.5 text-red-600 text-xs font-mono">{message}</p>
    </div>
  );
}
