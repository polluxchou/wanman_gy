interface EmptyStateProps {
  title: string;
  description?: string;
  icon?: string;
  className?: string;
}

export function EmptyState({ title, description, icon = '○', className = '' }: EmptyStateProps) {
  return (
    <div className={`flex flex-col items-center justify-center py-16 text-center ${className}`}>
      <span className="text-3xl mb-3 text-stone-300">{icon}</span>
      <p className="text-sm font-medium text-stone-500">{title}</p>
      {description && (
        <p className="mt-1 text-xs text-stone-400 max-w-sm leading-relaxed">{description}</p>
      )}
    </div>
  );
}
