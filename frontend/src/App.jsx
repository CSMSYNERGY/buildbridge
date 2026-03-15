import { BrowserRouter, Routes, Route, Navigate } from 'react-router';
import { AuthProvider } from './context/AuthProvider.jsx';
import { ToastProvider } from './components/ui/toast.jsx';
import AppLayout from './layouts/AppLayout.jsx';
import Home from './pages/Home.jsx';
import Subscription from './pages/Subscription.jsx';
import Mappers from './pages/Mappers.jsx';
import Mapper from './pages/Mapper.jsx';
import SmartBuild from './pages/SmartBuild.jsx';

export default function App() {
  return (
    <BrowserRouter>
      <AuthProvider>
        <ToastProvider>
        <Routes>
          <Route path="/app" element={<AppLayout />}>
            <Route index element={<Home />} />
            <Route path="subscription" element={<Subscription />} />
            <Route path="mappers" element={<Mappers />} />
            <Route path="mappers/new" element={<Mapper />} />
            <Route path="mappers/:id" element={<Mapper />} />
            <Route path="smartbuild" element={<SmartBuild />} />
          </Route>
          {/* Redirect bare root to /app */}
          <Route path="/" element={<Navigate to="/app" replace />} />
        </Routes>
        </ToastProvider>
      </AuthProvider>
    </BrowserRouter>
  );
}
