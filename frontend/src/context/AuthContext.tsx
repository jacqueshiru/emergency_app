import React, { createContext, useContext, useState, useEffect } from 'react';
import { UserDTO, Role } from '@seas/shared';
import { api } from '../services/api';
import * as store from '../services/tokenStore';

interface AuthContextType {
  user: UserDTO | null;
  isAuthenticated: boolean;
  isAdmin: boolean;
  loading: boolean;
  login: (phoneNumber: string, code: string, name?: string) => Promise<void>;
  logout: () => Promise<void>;
  setUser: (user: UserDTO | null) => void;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

export const AuthProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [user, setUser] = useState<UserDTO | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const storedUser = store.getItem('seas_user');
    const token = store.getItem('seas_access_token');
    let cancelled = false;
    (async () => {
      if (storedUser && token) {
        try {
          // Refresh first if the access token is already expired, so the UI never flashes
          // logged-out or fires a doomed first request. `loading` stays true until done.
          await api.ensureFreshSession();
          if (!cancelled) setUser(JSON.parse(storedUser));
        } catch {
          // Offline keeps the session; a real refresh failure already cleared storage + redirected.
          if (store.getItem('seas_access_token') && !cancelled) {
            try { setUser(JSON.parse(storedUser)); } catch { store.removeItem('seas_user'); }
          }
        }
      }
      if (!cancelled) setLoading(false);
    })();
    return () => { cancelled = true; };
  }, []);

  const login = async (phoneNumber: string, code: string, name?: string) => {
    const data = await api.verifyOtp(phoneNumber, code, name);
    setUser(data.user);
  };

  const logout = async () => {
    await api.logout();
    setUser(null);
  };

  const isAuthenticated = Boolean(user && store.getItem('seas_access_token'));
  const isAdmin = user?.role === Role.ADMIN;

  return (
    <AuthContext.Provider value={{ user, isAuthenticated, isAdmin, loading, login, logout, setUser }}>
      {children}
    </AuthContext.Provider>
  );
};

export const useAuth = () => {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
};
