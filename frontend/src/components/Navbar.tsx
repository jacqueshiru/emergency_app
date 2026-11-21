import React, { useState, useEffect } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { ShieldAlert, Users, LayoutDashboard, LogOut, Wifi, WifiOff, ShieldCheck } from 'lucide-react';

export const Navbar: React.FC = () => {
  const { user, isAdmin, logout } = useAuth();
  const location = useLocation();
  const [isOnline, setIsOnline] = useState(navigator.onLine);

  useEffect(() => {
    const handleOnline = () => setIsOnline(true);
    const handleOffline = () => setIsOnline(false);

    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);

    return () => {
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
    };
  }, []);

  return (
    <nav className="bg-zinc-950 border-b border-zinc-800 text-zinc-100 px-4 py-3 sticky top-0 z-50">
      <div className="max-w-5xl mx-auto flex items-center justify-between">
        <Link to="/" className="flex items-center space-x-2.5 font-bold tracking-tight text-red-500 hover:text-red-400">
          <div className="bg-red-500/10 p-1.5 rounded-lg border border-red-500/20">
            <ShieldAlert className="w-5 h-5 text-red-500" />
          </div>
          <span className="text-lg text-white">SEAS</span>
        </Link>

        <div className="flex items-center space-x-1 sm:space-x-3">
          {/* Online/Offline status pill */}
          <div
            className={`flex items-center space-x-1.5 px-2.5 py-1 rounded-full text-xs font-medium border ${
              isOnline
                ? 'bg-emerald-950/60 text-emerald-400 border-emerald-800/40'
                : 'bg-amber-950/60 text-amber-400 border-amber-800/40'
            }`}
          >
            {isOnline ? <Wifi className="w-3 h-3" /> : <WifiOff className="w-3 h-3" />}
            <span className="hidden sm:inline">{isOnline ? 'Online' : 'Offline Mode'}</span>
          </div>

          <Link
            to="/"
            className={`px-3 py-1.5 rounded-md text-sm font-medium transition-colors ${
              location.pathname === '/'
                ? 'bg-red-600/20 text-red-400 border border-red-500/30'
                : 'text-zinc-400 hover:text-zinc-100 hover:bg-zinc-900'
            }`}
          >
            SOS
          </Link>

          <Link
            to="/contacts"
            className={`flex items-center space-x-1 px-3 py-1.5 rounded-md text-sm font-medium transition-colors ${
              location.pathname === '/contacts'
                ? 'bg-zinc-800 text-white'
                : 'text-zinc-400 hover:text-zinc-100 hover:bg-zinc-900'
            }`}
          >
            <Users className="w-4 h-4" />
            <span className="hidden sm:inline">Contacts</span>
          </Link>

          <Link
            to="/privacy"
            className={`flex items-center space-x-1 px-3 py-1.5 rounded-md text-sm font-medium transition-colors ${
              location.pathname === '/privacy'
                ? 'bg-zinc-800 text-white'
                : 'text-zinc-400 hover:text-zinc-100 hover:bg-zinc-900'
            }`}
          >
            <ShieldCheck className="w-4 h-4" />
            <span className="hidden sm:inline">Privacy</span>
          </Link>

          {isAdmin && (
            <Link
              to="/admin"
              className={`flex items-center space-x-1 px-3 py-1.5 rounded-md text-sm font-medium transition-colors ${
                location.pathname.startsWith('/admin')
                  ? 'bg-zinc-800 text-white'
                  : 'text-zinc-400 hover:text-zinc-100 hover:bg-zinc-900'
              }`}
            >
              <LayoutDashboard className="w-4 h-4" />
              <span className="hidden sm:inline">Admin</span>
            </Link>
          )}

          <div className="h-4 w-px bg-zinc-800 mx-1"></div>

          <button
            onClick={() => logout()}
            className="flex items-center space-x-1 text-xs text-zinc-400 hover:text-red-400 px-2.5 py-1.5 rounded-md hover:bg-zinc-900 transition-colors"
            title="Log out"
          >
            <LogOut className="w-3.5 h-3.5" />
            <span className="hidden md:inline">{user?.phoneNumber}</span>
          </button>
        </div>
      </div>
    </nav>
  );
};
