import { useState, type FormEvent } from 'react';
import type { Team, User } from '../../shared/types';
import { PlusIcon } from './icons';

interface Props {
  team: Team;
  currentUser: User;
  onInviteMember: (email: string) => Promise<boolean>;
  onRemoveMember: (email: string) => Promise<boolean>;
}

export function TeamHeader({
  team,
  currentUser,
  onInviteMember,
  onRemoveMember,
}: Props) {
  const [showInvite, setShowInvite] = useState(false);
  const [inviteEmail, setInviteEmail] = useState('');
  const [busy, setBusy] = useState(false);
  const [inviteError, setInviteError] = useState<string | null>(null);

  const isOwner =
    team.ownerId === currentUser.id ||
    team.ownerEmail.toLowerCase() === currentUser.email.toLowerCase();

  async function handleInvite(e: FormEvent) {
    e.preventDefault();
    const email = inviteEmail.trim();
    if (!email || busy) return;
    setBusy(true);
    setInviteError(null);
    const ok = await onInviteMember(email);
    setBusy(false);
    if (ok) {
      setInviteEmail('');
      setShowInvite(false);
    } else {
      setInviteError('Failed to invite member. Make sure the email is valid and not already added.');
    }
  }

  return (
    <div className="team-header-panel">
      <div className="team-header-top">
        <div className="team-title-wrap">
          <span className="team-badge-icon">👥</span>
          <div>
            <h1 className="team-title">{team.name}</h1>
            <p className="team-subtitle">
              Hosted by <strong>{team.ownerEmail}</strong> · Created {new Date(team.createdAt).toLocaleDateString()}
            </p>
          </div>
        </div>

        <button
          type="button"
          className="add-member-toggle-btn"
          onClick={() => {
            setShowInvite((v) => !v);
            setInviteError(null);
          }}
        >
          <PlusIcon />
          <span>Add Member</span>
        </button>
      </div>

      {showInvite && (
        <form className="invite-member-form" onSubmit={(e) => void handleInvite(e)}>
          <div className="invite-input-row">
            <input
              type="email"
              className="invite-email-input"
              placeholder="Teammate's email (e.g. colleague@example.com)…"
              value={inviteEmail}
              autoFocus
              onChange={(e) => setInviteEmail(e.target.value)}
            />
            <button
              type="submit"
              className="invite-submit-btn"
              disabled={busy || !inviteEmail.trim()}
            >
              {busy ? 'Adding…' : 'Add to Team'}
            </button>
            <button
              type="button"
              className="cancel-btn"
              onClick={() => {
                setShowInvite(false);
                setInviteError(null);
              }}
            >
              Cancel
            </button>
          </div>
          {inviteError && <p className="invite-error-text">{inviteError}</p>}
        </form>
      )}

      <div className="team-members-bar">
        <span className="members-bar-label">Members ({team.members.length}):</span>
        <div className="members-chips-list">
          {team.members.map((member) => {
            const isHost = member.role === 'owner';
            const isMe = member.email.toLowerCase() === currentUser.email.toLowerCase();
            const canRemove = (isOwner && !isHost) || (!isOwner && isMe);

            return (
              <span
                key={member.email}
                className={`member-chip${isHost ? ' host-chip' : ''}${isMe ? ' me-chip' : ''}`}
                title={member.email}
              >
                <span className="member-avatar-mini">
                  {member.email.slice(0, 1).toUpperCase()}
                </span>
                <span className="member-email-text">{member.email}</span>
                {isHost && <span className="member-role-tag">Host</span>}
                {isMe && !isHost && <span className="member-role-tag">You</span>}
                {canRemove && (
                  <button
                    type="button"
                    className="member-remove-btn"
                    title={isMe ? 'Leave team' : 'Remove from team'}
                    onClick={() => void onRemoveMember(member.email)}
                  >
                    ×
                  </button>
                )}
              </span>
            );
          })}
        </div>
      </div>
    </div>
  );
}
