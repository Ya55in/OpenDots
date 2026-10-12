import { useState } from 'react';
import {
  ArrowLeft,
  Palette,
  Users,
  Brain,
  SlidersHorizontal,
  Folder,
  Bot,
} from 'lucide-react';
import type { Dot, State, WorkspaceState } from '../shared/types';
import { MembersPanel } from './MembersPanel';
import { ModelRouting } from './ModelRouting';
import { SpaceStorage } from './SpaceStorage';
import {
  themePreference,
  setThemePreference,
  type ThemePreference,
} from './theme';

type Tab = 'general' | 'agents' | 'learning' | 'storage' | 'models' | 'users';
export function SettingsPage({
  state,
  workspace,
  onBack,
  onEditDot,
  onSpace,
  mutate,
}: {
  state: State;
  workspace: WorkspaceState;
  onBack: () => void;
  onEditDot: (dot: Dot) => void;
  onSpace: (id: string) => void;
  mutate: (path: string, method: string, body?: unknown) => Promise<boolean>;
}) {
  const admin = workspace.isAdmin !== false;
  const [tab, setTab] = useState<Tab>('general');
  const [theme, setTheme] = useState(themePreference);
  const [saving, setSaving] = useState(false);
  const tabs = [
    { id: 'general' as const, label: 'General', icon: Palette },
    { id: 'agents' as const, label: 'Agents', icon: Bot },
    ...(admin
      ? [{ id: 'learning' as const, label: 'Learning', icon: Brain }]
      : []),
    { id: 'storage' as const, label: 'Spaces & files', icon: Folder },
    ...(admin
      ? [
          {
            id: 'models' as const,
            label: 'Models & usage',
            icon: SlidersHorizontal,
          },
          { id: 'users' as const, label: 'Users', icon: Users },
        ]
      : []),
  ];
  return (
    <main className="settings-page">
      <header className="settings-heading">
        <div>
          <span className="eyebrow">YOUR WORKSPACE</span>
          <h1>Settings</h1>
          <p className="muted">
            {admin
              ? 'Manage your agents, team, and workspace.'
              : 'Your preferences and assigned workspace.'}
          </p>
        </div>
        <button onClick={onBack}>
          <ArrowLeft size={16} /> Back to chat
        </button>
      </header>
      <div className="settings-layout">
        <nav className="settings-nav" aria-label="Settings sections">
          {tabs.map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              aria-current={tab === id ? 'page' : undefined}
              onClick={() => setTab(id)}
            >
              <Icon size={18} />
              {label}
            </button>
          ))}
        </nav>
        <section
          className="settings-content"
          aria-label={tabs.find((t) => t.id === tab)?.label}
        >
          {tab === 'general' && (
            <>
              <h2>Make yourself at home</h2>
              <p className="muted">Choose how OpenDots looks on this device.</p>
              <fieldset className="settings-card">
                <legend>Appearance</legend>
                <div
                  className="segmented"
                  role="radiogroup"
                  aria-label="Color theme"
                >
                  {(['system', 'light', 'dark'] as ThemePreference[]).map(
                    (option) => (
                      <label key={option}>
                        <input
                          type="radio"
                          name="theme"
                          checked={theme === option}
                          onChange={() => {
                            setTheme(option);
                            setThemePreference(option);
                          }}
                        />
                        <span>{option[0].toUpperCase() + option.slice(1)}</span>
                      </label>
                    ),
                  )}
                </div>
              </fieldset>
              {admin && (
                <section className="settings-card">
                  <h3>Workspace permissions</h3>
                  {(['researchAllowed', 'memoryAllowed'] as const).map(
                    (key) => (
                      <label className="permission-row" key={key}>
                        <input
                          type="checkbox"
                          checked={state.settings[key]}
                          disabled={saving}
                          onChange={async (e) => {
                            setSaving(true);
                            try {
                              await mutate('/settings', 'PATCH', {
                                [key]: e.target.checked,
                              });
                            } finally {
                              setSaving(false);
                            }
                          }}
                        />
                        <span>
                          {key === 'researchAllowed'
                            ? 'Public-page research'
                            : 'Use saved memories'}
                        </span>
                      </label>
                    ),
                  )}
                  <p className="muted">
                    Changing these permissions stops active work. Agent
                    permissions also apply.
                  </p>
                </section>
              )}
              <section className="settings-card">
                <h3>Chat controls</h3>
                <p>
                  Copy any message from its action row. Open Chat options to
                  choose a model or enable interactive responses. Interactive
                  mode is saved separately for each person and agent.
                </p>
              </section>
              {admin && (
                <details className="settings-card">
                  <summary>Service status</summary>
                  <p>
                    Text:{' '}
                    {workspace.setup.missing.length
                      ? `Missing ${workspace.setup.missing.join(', ')}`
                      : 'Configuration present'}
                    . Voice:{' '}
                    {workspace.setup.voice ? 'Configured' : 'Not configured'}.
                    Slack: {workspace.setup.slack.replaceAll('_', ' ')}.
                  </p>
                  <a
                    href="https://github.com/CopilotKit/OpenDots/blob/main/docs/SETUP-TELEMETRY.md"
                    target="_blank"
                    rel="noreferrer"
                  >
                    Setup telemetry and opt-out details ↗
                  </a>
                </details>
              )}
            </>
          )}
          {tab === 'agents' && (
            <>
              <h2>Your agents</h2>
              <p className="muted">
                {admin
                  ? 'Instructions, knowledge, connections, and permissions in one place.'
                  : 'Agents and Spaces available to your account.'}
              </p>
              {workspace.dots.map((dot) => (
                <article className="settings-card" key={dot.id}>
                  <h3>{dot.name}</h3>
                  <p className="muted">
                    {workspace.spaces
                      .filter((s) => dot.spaceIds.includes(s.id))
                      .map((s) => s.name)
                      .join(' · ')}
                  </p>
                  <details>
                    <summary>Role instructions</summary>
                    <p className="agent-instructions">{dot.instructions}</p>
                  </details>
                  {admin && (
                    <button onClick={() => onEditDot(dot)}>
                      Configure agent
                    </button>
                  )}
                </article>
              ))}
            </>
          )}
          {tab === 'learning' && admin && (
            <>
              <h2>Learning & memory</h2>
              <p className="muted">
                Keep each agent’s learning separate. Learning uses your
                configured Intelligence project; imported knowledge and saved
                memories remain separate sources.
              </p>
              <ol className="learning-steps">
                <li>Create a container in Intelligence for this agent.</li>
                <li>
                  Assign its Learning ID below. Only new conversations inherit
                  it.
                </li>
                <li>
                  Review learned skills in Intelligence before publishing.
                </li>
                <li>
                  Enable skill delivery in Intelligence and on this agent.
                </li>
              </ol>
              <a
                href="https://docs.copilotkit.ai/learning"
                target="_blank"
                rel="noreferrer"
              >
                Open Learning setup guide ↗
              </a>
              {workspace.dots.map((dot) => (
                <article className="settings-card" key={dot.id}>
                  <h3>{dot.name}</h3>
                  <dl>
                    <dt>Learning ID for new chats</dt>
                    <dd>
                      <code>{dot.learningContainerId || 'Not configured'}</code>
                    </dd>
                    <dt>Published skills</dt>
                    <dd>{dot.skillDeliveryEnabled ? 'Enabled' : 'Off'}</dd>
                    <dt>Conversations enrolled</dt>
                    <dd>
                      {
                        workspace.conversations.filter(
                          (c) => c.dotId === dot.id && c.learningContainerId,
                        ).length
                      }
                    </dd>
                  </dl>
                  <button onClick={() => onEditDot(dot)}>
                    Configure learning
                  </button>
                </article>
              ))}
              <p className="muted">
                Existing conversations keep their assigned ID. Disabling
                published skills stops skill delivery, not evidence collection.
                Member conversations retain the existing isolation policy and
                are not enrolled in owner learning.
              </p>
            </>
          )}
          {tab === 'storage' && (
            <>
              <h2>Spaces & files</h2>
              <p className="muted">
                Files and knowledge follow Space access permissions.
              </p>
              {workspace.spaces.map((space) => (
                <article className="settings-card" key={space.id}>
                  <h3>{space.name}</h3>
                  <p>{space.description}</p>
                  <div className="settings-card-actions">
                    <button onClick={() => onSpace(space.id)}>
                      Open Space
                    </button>
                    {admin && (
                      <SpaceStorage
                        space={space}
                        dots={workspace.dots.filter((d) =>
                          d.spaceIds.includes(space.id),
                        )}
                      />
                    )}
                  </div>
                </article>
              ))}
            </>
          )}
          {tab === 'models' && admin && (
            <>
              <h2>Models & consumption</h2>
              <p className="muted">
                Choose a conversation’s model in Chat options. Usage is visible
                only to administrators.
              </p>
              <ModelRouting />
            </>
          )}
          {tab === 'users' && admin && (
            <>
              <h2>Users</h2>
              <MembersPanel workspace={workspace} />
            </>
          )}
        </section>
      </div>
    </main>
  );
}
