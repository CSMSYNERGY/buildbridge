import { useEffect } from 'react';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router';
import { AuthProvider } from './context/AuthProvider.jsx';
import { ToastProvider } from './components/ui/toast.jsx';
import FeedbackWidget from './components/FeedbackWidget.jsx';
import ErrorBoundary from './components/ErrorBoundary.jsx';
import { installGlobalErrorReporting } from './lib/reportError.js';
import AppLayout from './layouts/AppLayout.jsx';
import Home from './pages/Home.jsx';
import Subscription from './pages/Subscription.jsx';
import SmartBuild from './pages/SmartBuild.jsx';
import QuickBooks from './pages/QuickBooks.jsx';

export default function App() {
  // Global window.onerror / unhandledrejection → error_events.
  useEffect(() => { installGlobalErrorReporting(); }, []);

  return (
    <ErrorBoundary>
    <BrowserRouter>
      <AuthProvider>
        <ToastProvider>
        <Routes>
          <Route path="/buildbridge" element={<AppLayout />}>
            <Route index element={<Home />} />
            <Route path="subscription" element={<Subscription />} />
            <Route path="smartbuild" element={<SmartBuild />} />
            <Route path="quickbooks" element={<QuickBooks />} />
          </Route>
          {/* Redirect bare root to /buildbridge */}
          <Route path="/" element={<Navigate to="/buildbridge" replace />} />
        </Routes>
        {/* Mounted outside <Routes> so it floats on every screen */}
        <FeedbackWidget />
        </ToastProvider>
      </AuthProvider>
    </BrowserRouter>
    </ErrorBoundary>
  );
}
