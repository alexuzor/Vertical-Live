/**
 * Vertical Live dashboard shell — a faithful reproduction of the reference.
 *
 * Header · [ preview + status | control panels + actions ] · footer, with the
 * confirmation modal and toast layered on top.
 */

import { useState } from 'react';

import { BUILD_REV, BUILD_TIME } from '@shared/buildInfo';

import { ActionsBar } from './components/ActionsBar';
import { AppFooter } from './components/AppFooter';
import { AppHeader } from './components/AppHeader';
import { BootScreen } from './components/BootScreen';
import { DevicesPanel } from './components/DevicesPanel';
import { FacebookConnectionPanel } from './components/FacebookConnectionPanel';
import { PortraitPreview } from './components/PortraitPreview';
import { RecordingPanel } from './components/RecordingPanel';
import { StreamQualityPanel } from './components/StreamQualityPanel';
import { Toast } from './components/Toast';
import { UpdateBanner } from './components/UpdateBanner';
import { ConfirmationDialog } from './components/dialogs/ConfirmationDialog';
import { DashboardProvider, useDashboard } from './hooks/useDashboard';
import { useFitToWindow } from './hooks/useFitToWindow';

function Dashboard() {
  const d = useDashboard();
  useFitToWindow();

  return (
    <div className="shell">
      <AppHeader />

      <div className="body">
        <div className="body__left">
          <PortraitPreview />
        </div>

        <div className="body__right">
          <DevicesPanel />
          <StreamQualityPanel />
          <FacebookConnectionPanel />
          <RecordingPanel />
          <ActionsBar />
        </div>
      </div>

      <AppFooter />

      <UpdateBanner />

      <ConfirmationDialog
        open={d.modal !== null}
        variant={d.modal?.variant ?? 'stop-stream'}
        busy={d.modalBusy}
        onCancel={d.cancelModal}
        onConfirm={d.confirmModal}
      />

      <Toast />
    </div>
  );
}

export default function App() {
  const [booted, setBooted] = useState(false);

  return (
    <>
      {booted ? (
        <DashboardProvider>
          <Dashboard />
        </DashboardProvider>
      ) : (
        <BootScreen onReady={() => setBooted(true)} />
      )}

      {/* Dev-only proof of which source is running; never present in a build. */}
      {import.meta.env.DEV && (
        <div className="dev-badge" title={BUILD_TIME ? `Built ${BUILD_TIME}` : undefined}>
          DEV BUILD · {BUILD_REV}
        </div>
      )}
    </>
  );
}
