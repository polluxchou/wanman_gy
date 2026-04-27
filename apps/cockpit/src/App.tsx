import { useState } from 'react';
import { Layout } from './components/Layout.js';
import { Sidebar } from './components/Sidebar.js';
import { Overview } from './pages/Overview.js';
import { TaskBoard } from './pages/TaskBoard.js';
import { AgentList } from './pages/AgentList.js';
import { Messages } from './pages/Messages.js';
import { Artifacts } from './pages/Artifacts.js';
import { HumanInbox } from './pages/HumanInbox.js';
import { RuntimeControl } from './pages/RuntimeControl.js';

export type Page = 'overview' | 'runtime' | 'tasks' | 'agents' | 'messages' | 'artifacts' | 'inbox';

export function App() {
  const [page, setPage] = useState<Page>('overview');

  function navigateTo(target: Page) {
    setPage(target);
  }

  const content = (() => {
    switch (page) {
      case 'overview':
        return <Overview onNavigate={navigateTo} />;
      case 'runtime':
        return <RuntimeControl />;
      case 'tasks':
        return <TaskBoard />;
      case 'agents':
        return <AgentList />;
      case 'messages':
        return (
          <Messages
            onNavigateToTask={(_taskId) => {
              // Navigate to tasks page — the task id could be used for pre-selection in a future stage
              navigateTo('tasks');
            }}
          />
        );
      case 'artifacts':
        return <Artifacts />;
      case 'inbox':
        return <HumanInbox onNavigate={navigateTo} />;
    }
  })();

  return (
    <Layout sidebar={<Sidebar current={page} onNavigate={navigateTo} />}>
      {content}
    </Layout>
  );
}
