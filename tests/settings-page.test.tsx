import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it, vi } from 'vitest';
vi.mock('../src/client/api', () => ({ api: vi.fn() }));
vi.mock('../src/client/theme', () => ({
  themePreference: () => 'system',
  setThemePreference: vi.fn(),
}));
import { SettingsPage } from '../src/client/SettingsPage';
import type { State, WorkspaceState } from '../src/shared/types';
const state = {
  settings: { researchAllowed: true, memoryAllowed: false },
} as State;
const workspace = {
  dots: [],
  spaces: [],
  conversations: [],
  setup: { missing: [], slack: 'off', voice: false },
} as unknown as WorkspaceState;
it('gives members personal settings without exposing admin tabs or global permissions', () => {
  const html = renderToStaticMarkup(
    <SettingsPage
      state={state}
      workspace={{ ...workspace, isAdmin: false }}
      onBack={() => {}}
      onEditDot={() => {}}
      onSpace={() => {}}
      mutate={async () => true}
    />,
  );
  expect(html).toContain('Settings sections');
  expect(html).toContain('Spaces &amp; files');
  expect(html).not.toContain('Users</button>');
  expect(html).not.toContain('Models &amp; usage');
  expect(html).not.toContain('Workspace permissions');
  expect(html).not.toContain('role="dialog"');
});
it('presents separate admin navigation for users, learning and usage', () => {
  const html = renderToStaticMarkup(
    <SettingsPage
      state={state}
      workspace={workspace}
      onBack={() => {}}
      onEditDot={() => {}}
      onSpace={() => {}}
      mutate={async () => true}
    />,
  );
  expect(html).toContain('Users</button>');
  expect(html).toContain('Learning</button>');
  expect(html).toContain('Models &amp; usage');
});
