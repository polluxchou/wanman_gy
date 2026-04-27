import type { ReactNode } from 'react';

interface LayoutProps {
  sidebar: ReactNode;
  children: ReactNode;
}

export function Layout({ sidebar, children }: LayoutProps) {
  return (
    <div className="flex h-screen overflow-hidden bg-stone-50">
      {sidebar}
      <main className="flex-1 overflow-y-auto">{children}</main>
    </div>
  );
}

interface PageHeaderProps {
  title: string;
  subtitle?: string;
  actions?: ReactNode;
}

export function PageHeader({ title, subtitle, actions }: PageHeaderProps) {
  return (
    <div className="flex items-start justify-between px-6 pt-6 pb-4 border-b border-stone-200 bg-white sticky top-0 z-10">
      <div>
        <h1 className="text-lg font-semibold text-stone-900">{title}</h1>
        {subtitle && <p className="mt-0.5 text-xs text-stone-500">{subtitle}</p>}
      </div>
      {actions && <div className="flex items-center gap-2">{actions}</div>}
    </div>
  );
}

interface SectionProps {
  title?: string;
  children: ReactNode;
  className?: string;
}

export function Section({ title, children, className = '' }: SectionProps) {
  return (
    <section className={className}>
      {title && (
        <h2 className="px-6 py-3 text-xs font-semibold text-stone-500 uppercase tracking-wider border-b border-stone-100">
          {title}
        </h2>
      )}
      {children}
    </section>
  );
}
