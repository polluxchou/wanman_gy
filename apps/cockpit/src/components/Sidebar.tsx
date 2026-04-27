import type { Page } from '../App.js';
import { useHealth } from '../hooks/useWanman.js';
import { useHumanActions } from '../hooks/useWanman.js';

interface NavItem {
  id: Page;
  label: string;
  icon: string;
}

const NAV_ITEMS: NavItem[] = [
  { id: 'overview', label: 'Overview', icon: '◉' },
  { id: 'runtime', label: 'Runtime', icon: '▣' },
  { id: 'tasks', label: 'Tasks', icon: '☰' },
  { id: 'agents', label: 'Agents', icon: '◎' },
  { id: 'messages', label: 'Messages', icon: '◇' },
  { id: 'artifacts', label: 'Artifacts', icon: '◈' },
  { id: 'inbox', label: 'Inbox', icon: '△' },
];

interface SidebarProps {
  current: Page;
  onNavigate: (page: Page) => void;
}

export function Sidebar({ current, onNavigate }: SidebarProps) {
  const { data: health, isError } = useHealth();
  const { data: actions } = useHumanActions({ status: 'open' });
  const inboxCount = (actions ?? []).filter(a => !a.handled).length;

  const connectionDot = isError
    ? 'bg-red-500'
    : health
      ? 'bg-emerald-500'
      : 'bg-amber-400 animate-pulse';

  return (
    <aside className="w-52 flex-shrink-0 bg-white border-r border-stone-200 flex flex-col h-full">
      {/* Header */}
      <div className="px-4 pt-5 pb-4 border-b border-stone-200">
        <div className="flex items-center gap-2">
          <span className="text-stone-900 font-semibold tracking-tight text-base">Wanman</span>
          <span className="text-stone-400 text-xs font-medium">cockpit</span>
        </div>
        <div className="mt-2 flex items-center gap-1.5">
          <span className={`w-2 h-2 rounded-full flex-shrink-0 ${connectionDot}`} />
          <span className="text-xs text-stone-500 truncate">
            {isError
              ? 'Supervisor offline'
              : health
                ? `${health.agents.length} agent${health.agents.length !== 1 ? 's' : ''} · ${health.runtime.completedRuns} runs`
                : 'Connecting…'}
          </span>
        </div>
      </div>

      {/* Navigation */}
      <nav className="flex-1 px-2 py-3 space-y-0.5 overflow-y-auto">
        {NAV_ITEMS.map(item => {
          const isActive = current === item.id;
          const badge = item.id === 'inbox' && inboxCount > 0 ? inboxCount : null;

          return (
            <button
              key={item.id}
              onClick={() => onNavigate(item.id)}
              className={`w-full flex items-center gap-2.5 px-3 py-1.5 rounded-md text-left transition-colors ${
                isActive
                  ? 'bg-orange-50 text-orange-700 font-medium'
                  : 'text-stone-600 hover:text-stone-900 hover:bg-stone-50'
              }`}
            >
              <span className="text-base leading-none flex-shrink-0">{item.icon}</span>
              <span className="text-sm flex-1">{item.label}</span>
              {badge !== null && (
                <span className="bg-orange-500 text-white text-xs font-bold rounded-full min-w-[18px] h-[18px] flex items-center justify-center px-1">
                  {badge > 99 ? '99+' : badge}
                </span>
              )}
            </button>
          );
        })}
      </nav>

      {/* Footer */}
      <div className="px-4 py-3 border-t border-stone-200">
        <p className="text-xs text-stone-400">Stage 4 · Runtime Control</p>
      </div>
    </aside>
  );
}
