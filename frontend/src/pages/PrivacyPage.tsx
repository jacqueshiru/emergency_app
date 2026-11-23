import React, { useState } from 'react';
import { api } from '../services/api';
import { useAuth } from '../context/AuthContext';
import { Download, Trash2, ShieldCheck, KeyRound } from 'lucide-react';
import QRCode from 'qrcode';

export const PrivacyPage: React.FC = () => {
  const { logout } = useAuth();
  const [message, setMessage] = useState('');
  const [mfaCode, setMfaCode] = useState('');
  const [mfaSecret, setMfaSecret] = useState('');
  const [mfaQrCode, setMfaQrCode] = useState('');

  const setupMfa = async () => {
    try {
      const result = await api.setupAdminMfa();
      setMfaSecret(result.secret);
      setMfaCode('');
      setMessage('');
      setMfaQrCode(await QRCode.toDataURL(result.otpauth, { errorCorrectionLevel: 'M', margin: 2, width: 220 }));
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
        <p className="text-xs text-amber-300">Generating a new QR code replaces any previous authenticator setup for this account.</p>
        <button onClick={setupMfa} className="px-4 py-2 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-sm">Generate authenticator QR</button>
        {mfaQrCode && (
          <div className="inline-flex flex-col items-center gap-2 rounded-xl bg-white p-3">
            <img src={mfaQrCode} alt="Scan this QR code with your authenticator app" width={220} height={220} />
            <span className="text-xs text-zinc-700">Scan with your authenticator app</span>
          </div>
        )}
        {mfaSecret && (
          <p className="text-xs text-zinc-400 break-all">
            If scanning is unavailable, enter this setup key manually: <span className="font-mono text-zinc-200">{mfaSecret}</span>
          </p>
        )}
        <div className="flex gap-2">
          <input
            value={mfaCode}
            onChange={(e) => setMfaCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
            inputMode="numeric"
            autoComplete="one-time-code"
            maxLength={6}
            placeholder="6-digit code"
            className="bg-zinc-950 border border-zinc-700 rounded-lg px-3 py-2 text-sm"
          />
          <button onClick={verifyMfa} disabled={mfaCode.length !== 6} className="px-4 py-2 rounded-lg bg-emerald-700 hover:bg-emerald-600 disabled:opacity-50 text-sm">Verify</button>
        </div>
      </section>
      <section className="p-5 rounded-2xl bg-zinc-900 border border-zinc-800 space-y-3">
        <h2 className="font-semibold text-white flex items-center gap-2"><ShieldCheck className="w-5 h-5 text-blue-400" />Data rights</h2>
        <button onClick={exportData} className="flex items-center gap-2 px-4 py-2 rounded-lg bg-blue-700 hover:bg-blue-600 text-sm"><Download className="w-4 h-4" />Export my data</button>
        <button onClick={deleteAccount} className="flex items-center gap-2 px-4 py-2 rounded-lg bg-red-700 hover:bg-red-600 text-sm"><Trash2 className="w-4 h-4" />Delete my account</button>
      </section>
    </div>
  );
};
