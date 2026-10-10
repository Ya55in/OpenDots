import { useEffect, useState } from 'react';
import { api } from './api';
import type { WorkspaceState } from '../shared/types';
interface Member {
  id: string;
  name: string;
  email?: string;
  dotIds: string[];
  spaceIds: string[];
  active: boolean;
  createdAt: number;
}
const empty = {
  name: '',
  email: '',
  dotIds: [] as string[],
  spaceIds: [] as string[],
  active: true,
};
export function MembersPanel({ workspace }: { workspace: WorkspaceState }) {
  const [members, setMembers] = useState<Member[]>([]),
    [draft, setDraft] = useState(empty),
    [id, setId] = useState<string>(),
    [code, setCode] = useState(''),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  const refresh = async () => setMembers(await api<Member[]>('/admin/members'));
  useEffect(() => {
    void refresh().catch(() => setError('Members could not load.'));
  }, []);
  const save = async () => {
    setBusy(true);
    setError('');
    setCode('');
    try {
      if (id) await api(`/admin/members/${id}`, 'PUT', draft);
      else {
        const result = await api<{ token: string }>(
          '/admin/members',
          'POST',
          draft,
        );
        setCode(result.token);
      }
      await refresh();
      setId(undefined);
      setDraft(empty);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not save member.');
    } finally {
      setBusy(false);
    }
  };
  const rotate = async (member: Member) => {
    if (
      !window.confirm(
        `Replace ${member.name}’s access code? The old code will stop working.`,
      )
    )
      return;
    setBusy(true);
    try {
      const result = await api<{ token: string }>(
        `/admin/members/${member.id}/rotate`,
        'POST',
        {},
      );
      setCode(result.token);
      setError('');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not replace code.');
    } finally {
      setBusy(false);
    }
  };
  const toggle = (key: 'dotIds' | 'spaceIds', value: string) =>
    setDraft({
      ...draft,
      [key]: draft[key].includes(value)
        ? draft[key].filter((id) => id !== value)
        : [...draft[key], value],
    });
  return (
    <section
      className="members-panel"
      onKeyDown={(event) => {
        if (event.key === 'Enter' && event.target instanceof HTMLInputElement)
          event.preventDefault();
      }}
    >
      <h3>Member access</h3>
      <p className="muted">
        Create a separate access code for each colleague. Members see only
        selected agents and Spaces, with their own private conversations. Space
        access includes its shared pages, files and knowledge. Admin settings,
        connected-account management, computers, voice and consumption remain
        private.
      </p>
      {members.map((member) => (
        <div className="member-row" key={member.id}>
          <span>
            <strong>{member.name}</strong>
            <small>
              {member.active ? 'Active' : 'Revoked'} · {member.dotIds.length}{' '}
              agents · {member.spaceIds.length} Spaces
            </small>
          </span>
          <button
            type="button"
            disabled={busy}
            onClick={() => {
              setId(member.id);
              setDraft({
                name: member.name,
                email: member.email ?? '',
                dotIds: member.dotIds,
                spaceIds: member.spaceIds,
                active: member.active,
              });
              setCode('');
            }}
          >
            Edit access
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => void rotate(member)}
          >
            Replace code
          </button>
        </div>
      ))}
      <h4>{id ? 'Edit membership' : 'Create member'}</h4>
      <label>
        Name
        <input
          aria-label="Member name"
          value={draft.name}
          maxLength={80}
          onChange={(e) => setDraft({ ...draft, name: e.target.value })}
        />
      </label>
      <label>
        Email (optional contact label)
        <input
          aria-label="Member email"
          type="email"
          value={draft.email}
          onChange={(e) => setDraft({ ...draft, email: e.target.value })}
        />
      </label>
      <fieldset>
        <legend>Agents</legend>
        {workspace.dots.map((dot) => (
          <label className="permission-row" key={dot.id}>
            <input
              type="checkbox"
              checked={draft.dotIds.includes(dot.id)}
              onChange={() => toggle('dotIds', dot.id)}
            />
            {dot.name}
          </label>
        ))}
      </fieldset>
      <fieldset>
        <legend>Spaces</legend>
        {workspace.spaces.map((space) => (
          <label className="permission-row" key={space.id}>
            <input
              type="checkbox"
              checked={draft.spaceIds.includes(space.id)}
              onChange={() => toggle('spaceIds', space.id)}
            />
            {space.name}
          </label>
        ))}
      </fieldset>
      <p className="muted">
        Select at least one Space already assigned to each selected agent. A
        member’s agent access is limited to the intersection of those
        permissions.
      </p>
      <label className="permission-row">
        <input
          type="checkbox"
          checked={draft.active}
          onChange={(e) => setDraft({ ...draft, active: e.target.checked })}
        />
        Access active — uncheck to revoke
      </label>
      <button
        type="button"
        disabled={busy || !draft.name.trim()}
        onClick={() => void save()}
      >
        {busy ? 'Saving…' : id ? 'Save access' : 'Create member access'}
      </button>
      {id && (
        <button
          type="button"
          onClick={() => {
            setId(undefined);
            setDraft(empty);
          }}
        >
          Cancel edit
        </button>
      )}
      {error && <p role="alert">{error}</p>}
      {code && (
        <div className="config-note">
          <strong>New access code — shown only now</strong>
          <p>
            Share privately with this member. They enter it on the OpenDots
            sign-in screen. No email has been sent.
          </p>
          <input
            aria-label="New member access code"
            readOnly
            value={code}
            onFocus={(e) => e.target.select()}
          />
          <button type="button" onClick={() => setCode('')}>
            Hide code
          </button>
        </div>
      )}
    </section>
  );
}
