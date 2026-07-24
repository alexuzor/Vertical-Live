/**
 * Auto-update prompt.
 *
 * A slim card that floats below the header when the GitHub-Releases updater has
 * something to say. It mirrors the four active updater states: an offered
 * release the user can download, a download in progress, a build ready to
 * install, and a failure. It stays silent otherwise (idle / checking / up to
 * date / unsupported dev build), and "Later" hides it until the next state
 * change.
 */

import { useDashboard } from '../hooks/useDashboard';

import { IconAlertTriangle, IconDownload, IconRefresh } from './icons';

export function UpdateBanner() {
  const d = useDashboard();
  const u = d.update;

  const visible =
    u.state === 'downloading' ||
    u.state === 'downloaded' ||
    (u.state === 'available' && !u.dismissed) ||
    (u.state === 'error' && u.version !== null && !u.dismissed);
  if (!visible) return null;

  const version = u.version ? `v${u.version}` : 'A new version';

  return (
    <div className="update" data-state={u.state} role="status" aria-live="polite">
      {u.state === 'available' && (
        <>
          <span className="update__icon">
            <IconDownload size={18} />
          </span>
          <div className="update__body">
            <div className="update__title">Update available</div>
            <div className="update__text">{version} is ready to download.</div>
          </div>
          <div className="update__actions">
            <button type="button" className="update__btn" onClick={d.dismissUpdate}>
              Later
            </button>
            <button
              type="button"
              className="update__btn update__btn--primary"
              onClick={d.downloadUpdate}
            >
              Download
            </button>
          </div>
        </>
      )}

      {u.state === 'downloading' && (
        <>
          <span className="update__icon">
            <IconDownload size={18} />
          </span>
          <div className="update__body">
            <div className="update__title">Downloading update… {u.percent}%</div>
            <div className="update__bar" aria-hidden="true">
              <span className="update__bar-fill" style={{ width: `${u.percent}%` }} />
            </div>
          </div>
        </>
      )}

      {u.state === 'downloaded' && (
        <>
          <span className="update__icon update__icon--ready">
            <IconRefresh size={18} />
          </span>
          <div className="update__body">
            <div className="update__title">Update ready</div>
            <div className="update__text">
              {version} installs when you quit — or restart now.
            </div>
          </div>
          <div className="update__actions">
            <button type="button" className="update__btn" onClick={d.dismissUpdate}>
              Later
            </button>
            <button
              type="button"
              className="update__btn update__btn--primary"
              onClick={d.installUpdate}
            >
              Restart now
            </button>
          </div>
        </>
      )}

      {u.state === 'error' && (
        <>
          <span className="update__icon update__icon--error">
            <IconAlertTriangle size={18} />
          </span>
          <div className="update__body">
            <div className="update__title">Update failed</div>
            <div className="update__text">{u.message ?? 'Could not complete the update.'}</div>
          </div>
          <div className="update__actions">
            <button type="button" className="update__btn" onClick={d.dismissUpdate}>
              Dismiss
            </button>
          </div>
        </>
      )}
    </div>
  );
}
