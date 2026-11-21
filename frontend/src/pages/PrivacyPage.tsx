import React, { useState } from 'react';
import { api } from '../services/api';
import { useAuth } from '../context/AuthContext';
import { Download, Trash2, ShieldCheck, KeyRound } from 'lucide-react';

export const PrivacyPage: React.FC = () => {
  const { logout } = useAuth();
  const [message, setMessage] = useState('');
  const [mfaCode, setMfaCode] = useState('');

  const setupMfa = async () => {
    try {
      const result = await api.setupAdminMfa();
      setMessage(`Add this secret to your authenticator app: ${result.secret}`);
    } catch (err: any) { setMessage(err.message); }
  };
  const verifyMfa = async () => {
    try { await api.verifyAdminMfa(mfaCode); setMessage('Administrator MFA verified.'); }
    catch (err: any) { setMessage(err.message); }
  };
  const exportData = async () => {
    try { await api.exportMyData(); setMessage('Data export downloaded.'); }
    catch (err: any) { setMessage(err.message); }
  };
  const deleteAccount = async () => {
    if (!window.confirm('Permanently delete your account, contacts and alert history?')) return;
    try { await api.deleteMyAccount(); await logout(); window.location.href = '/login'; }
    catch (err: any) { setMessage(err.message); }
  };

  return (
    <div className="max-w-3xl mx-auto px-4 py-8 space-y-6">
      <h1 className="text-2xl font-bold text-white">Privacy & Security</h1>
      {message && <div className="p-3 rounded-xl bg-zinc-900 border border-zinc-700 text-sm text-zinc-200 break-all">{message}</div>}
      <section className="p-5 rounded-2xl bg-zinc-900 border border-zinc-800 space-y-3">
        <h2 className="font-semibold text-white flex items-center gap-2"><KeyRound className="w-5 h-5 text-emerald-400" />Administrator MFA</h2>
        <p className="text-sm text-zinc-400">Set up an authenticator app before using administrator pages.</p>
        <button onClick={setupMfa} className="px-4 py-2 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-sm">Create TOTP secret</button>
        <div className="flex gap-2"><input value={mfaCode} onChange={(e) => setMfaCode(e.target.value)} placeholder="6-digit code" className="bg-zinc-950 border border-zinc-700 rounded-lg px-3 py-2 text-sm" /><button onClick={verifyMfa} className="px-4 py-2 rounded-lg bg-emerald-700 hover:bg-emerald-600 text-sm">Verify</button></div>
      </section>
      <section className="p-5 rounded-2xl bg-zinc-900 border border-zinc-800 space-y-3">
        <h2 className="font-semibold text-white flex items-center gap-2"><ShieldCheck className="w-5 h-5 text-blue-400" />Data rights</h2>
        <button onClick={exportData} className="flex items-center gap-2 px-4 py-2 rounded-lg bg-blue-700 hover:bg-blue-600 text-sm"><Download className="w-4 h-4" />Export my data</button>
        <button onClick={deleteAccount} className="flex items-center gap-2 px-4 py-2 rounded-lg bg-red-700 hover:bg-red-600 text-sm"><Trash2 className="w-4 h-4" />Delete my account</button>
      </section>
    </div>
  );
};
