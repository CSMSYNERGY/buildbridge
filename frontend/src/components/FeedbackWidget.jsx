import { useState, useEffect } from 'react';

// ─── FeedbackWidget ───
// Reusable, self-contained customer feedback widget. Mount once near the app
// root: a floating "💬 Feedback" button (bottom-right) opens a modal offering
// "Report an Issue" / "Request a Feature"; each embeds the matching Monday.com
// WorkForm (public share link) in an iframe, so customers submit straight into
// the Monday boards without any login. React only — no other dependencies,
// inline styles, drops into any app unchanged except FEEDBACK_CONFIG below.
//
// ════════════════════════════════════════════════════════════════════════
//  FEEDBACK_CONFIG — the ONLY section to edit per app.
//
//  To go live, paste the two Monday WorkForm share URLs over the
//  PLACEHOLDER values (Monday board → Form view → Share → copy link;
//  they look like https://forms.monday.com/forms/<hash>?r=use1).
//  Nothing else needs to change.
// ════════════════════════════════════════════════════════════════════════
const FEEDBACK_CONFIG = {
  // "Report an Issue" Monday WorkForm share URL:
  bugFormUrl: 'https://forms.monday.com/forms/90b6f8b12b5e3a1229a34411450a2aae',
  // "Request a Feature" Monday WorkForm share URL:
  featureFormUrl: 'https://forms.monday.com/forms/2afe5b74ae8a1146bf33736beae5095e',
  // Sent to the form so every submission is tagged with the app it came from.
  appName: 'BuildBridge',
  // Name of the Monday form question that appName pre-fills.
  appFieldLabel: 'App',
  // Brand color for the launcher button and modal header.
  accent: '#3d3672',
};

// Appends ?<appFieldLabel>=<appName> to the form URL so Monday pre-fills the
// "App" question. NOTE: URL pre-fill is a paid Monday tier feature — on plans
// without it Monday simply ignores the query param and the form still loads
// and submits fine (the user picks the app manually), so this degrades
// gracefully either way.
// Also normalizes the plain share link (/forms/<hash>) to Monday's embeddable
// /forms/embed/<hash> variant: the share link is served with a frame-ancestors
// CSP that only allows monday.com itself, so browsers refuse to iframe it.
function feedbackFormSrc(url) {
  const embedUrl = url.indexOf('/forms/embed/') !== -1 ? url : url.replace('/forms/', '/forms/embed/');
  const sep = embedUrl.indexOf('?') === -1 ? '?' : '&';
  return embedUrl + sep + encodeURIComponent(FEEDBACK_CONFIG.appFieldLabel) + '=' + encodeURIComponent(FEEDBACK_CONFIG.appName);
}

const FEEDBACK_CHOICES = [
  { key: 'bug', icon: '🐛', label: 'Report an Issue', blurb: 'Something broken or not working as expected', urlKey: 'bugFormUrl' },
  { key: 'feature', icon: '✨', label: 'Request a Feature', blurb: "An idea or improvement you'd like to see", urlKey: 'featureFormUrl' },
];

export default function FeedbackWidget() {
  // null = closed · "menu" = choice screen · "bug" / "feature" = embedded form
  const [view, setView] = useState(null);

  useEffect(() => {
    if (!view) return;
    const onKey = (e) => { if (e.key === 'Escape') setView(null); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [view]);

  const { accent } = FEEDBACK_CONFIG;
  const choice = FEEDBACK_CHOICES.find((c) => c.key === view) || null;
  const formUrl = choice ? FEEDBACK_CONFIG[choice.urlKey] : null;
  const isConfigured = !!formUrl && formUrl.indexOf('PASTE_') !== 0;

  if (!view) {
    return (
      <button
        onClick={() => setView('menu')}
        aria-label="Send feedback"
        style={{
          position: 'fixed', right: 20, zIndex: 999999,
          // Stay above the zone GHL clips off the bottom of the iframe.
          bottom: 'calc(20px + var(--bb-clip-bottom, 0px))',
          background: accent, color: '#FFF', border: 'none', borderRadius: 999,
          padding: '10px 16px', fontSize: 14, fontWeight: 600, cursor: 'pointer',
          boxShadow: '0 4px 14px rgba(0,0,0,0.25)',
          fontFamily: 'system-ui, -apple-system, sans-serif',
        }}
      >
        💬 Feedback
      </button>
    );
  }

  return (
    <div
      onClick={() => setView(null)}
      role="dialog" aria-modal="true" aria-label={`${FEEDBACK_CONFIG.appName} feedback`}
      style={{
        position: 'fixed', inset: 0, zIndex: 999999, background: 'rgba(15,23,42,0.55)',
        display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16,
        fontFamily: 'system-ui, -apple-system, sans-serif',
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: '#FFF', borderRadius: 12, overflow: 'hidden',
          width: choice ? 'min(680px, 100%)' : 'min(420px, 100%)',
          maxHeight: 'min(720px, calc(100vh - 32px))',
          display: 'flex', flexDirection: 'column',
          boxShadow: '0 20px 60px rgba(0,0,0,0.35)',
        }}
      >
        <div style={{ background: accent, color: '#FFF', padding: '12px 16px', display: 'flex', alignItems: 'center', gap: 8 }}>
          {choice && (
            <button onClick={() => setView('menu')} aria-label="Back"
              style={{ background: 'none', border: 'none', color: '#FFF', cursor: 'pointer', fontSize: 16, padding: 0, lineHeight: 1 }}>←</button>
          )}
          <div style={{ fontSize: 14, fontWeight: 700, flex: 1 }}>
            {choice ? `${choice.icon} ${choice.label}` : '💬 Send us feedback'}
          </div>
          <button onClick={() => setView(null)} aria-label="Close"
            style={{ background: 'none', border: 'none', color: '#FFF', cursor: 'pointer', fontSize: 18, padding: 0, lineHeight: 1 }}>×</button>
        </div>

        {!choice ? (
          <div style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 10 }}>
            {FEEDBACK_CHOICES.map((c) => (
              <button key={c.key} onClick={() => setView(c.key)}
                style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '14px 16px', background: '#F8FAFC', border: '1px solid #E2E8F0', borderRadius: 10, cursor: 'pointer', textAlign: 'left' }}>
                <span style={{ fontSize: 22 }}>{c.icon}</span>
                <span>
                  <span style={{ display: 'block', fontSize: 14, fontWeight: 700, color: '#0F172A' }}>{c.label}</span>
                  <span style={{ display: 'block', fontSize: 12, color: '#64748B', marginTop: 2 }}>{c.blurb}</span>
                </span>
              </button>
            ))}
          </div>
        ) : isConfigured ? (
          <iframe
            src={feedbackFormSrc(formUrl)}
            title={`${choice.label} — ${FEEDBACK_CONFIG.appName}`}
            style={{ border: 0, width: '100%', height: 'min(560px, 70vh)', display: 'block', background: '#F8FAFC' }}
          />
        ) : (
          <div style={{ padding: 24, fontSize: 13, color: '#475569', lineHeight: 1.6 }}>
            This feedback form isn&apos;t connected yet — please check back soon.
            <br />
            <span style={{ color: '#94A3B8' }}>
              (Developer note: paste the Monday WorkForm share URL into <code>FEEDBACK_CONFIG.{choice.urlKey}</code> in FeedbackWidget.jsx.)
            </span>
          </div>
        )}
      </div>
    </div>
  );
}
