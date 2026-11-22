import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { api } from '../services/api';
import { isNative } from '../services/platform';
import { getServerOrigin, setServerOrigin, checkServer } from '../services/config';
import { ShieldAlert, ArrowRight, KeyRound, Phone, User as UserIcon } from 'lucide-react';

export const LoginPage: React.FC = () => {
  const { login, isAuthenticated } = useAuth();
  const navigate = useNavigate();

  const [step, setStep] = useState<'phone' | 'otp'>('phone');
  const [phoneNumber, setPhoneNumber] = useState('');
  const [name, setName] = useState('');
  const [otpCode, setOtpCode] = useState('');
  const [devOtpCode, setDevOtpCode] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [cooldown, setCooldown] = useState(0);

  // Server address (Android app): needed with tunnels whose address changes on every restart.
  const [showServer, setShowServer] = useState(false);
  const [serverUrl, setServerUrl] = useState(getServerOrigin());
  const [serverCheck, setServerCheck] = useState<{ ok: boolean; message: string } | null>(null);
  const [checking, setChecking] = useState(false);

  const handleTestServer = async () => {
    setChecking(true);
    setServerCheck(null);
    const result = await checkServer(serverUrl);
    setServerCheck(result);
    if (result.ok && setServerOrigin(serverUrl)) setServerUrl(getServerOrigin());
    setChecking(false);
  };

  useEffect(() => {
    if (isAuthenticated) {
      navigate('/');
    }
  }, [isAuthenticated, navigate]);

  useEffect(() => {
    let timer: any;
    if (cooldown > 0) {
      timer = setTimeout(() => setCooldown((c) => c - 1), 1000);
    }
    return () => clearTimeout(timer);
  }, [cooldown]);

  const handleRequestOtp = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!phoneNumber.trim()) {
      setError('Please enter your phone number');
      return;
    }

    setLoading(true);
    setError(null);

    try {
      const result = await api.requestOtp(phoneNumber.trim(), name.trim() || undefined);
      setDevOtpCode(result.devCode ?? null);
      if (result.devCode) setOtpCode(result.devCode);
      setStep('otp');
      setCooldown(60);
    } catch (err: any) {
      setError(err.message || 'Failed to request verification code');
      if (err?.code === 'OFFLINE' && navigator.onLine) setShowServer(true);
    } finally {
      setLoading(false);
    }
  };

  const handleVerifyOtp = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!otpCode.trim()) {
      setError('Please enter the 6-digit code');
      return;
    }

    setLoading(true);
    setError(null);

    try {
      await login(phoneNumber.trim(), otpCode.trim(), name.trim() || undefined);
      navigate('/');
    } catch (err: any) {
      setError(err.message || 'Verification failed');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-zinc-950 flex flex-col justify-center items-center px-4 py-8">
      <div className="w-full max-w-md bg-zinc-900 border border-zinc-800 rounded-2xl p-6 sm:p-8 shadow-2xl">
        <div className="flex flex-col items-center text-center mb-8">
          <div className="bg-red-500/10 p-3 rounded-2xl border border-red-500/20 mb-3">
            <ShieldAlert className="w-10 h-10 text-red-500" />
          </div>
          <h1 className="text-2xl font-bold tracking-tight text-white">Smart Emergency Alert</h1>
          <p className="text-sm text-zinc-400 mt-1">Instant, resilient peer emergency dispatch</p>
        </div>

        {error && (
          <div className="mb-6 p-3 rounded-lg bg-red-950/50 border border-red-800 text-red-300 text-sm">
            {error}
          </div>
        )}

        {step === 'phone' ? (
          <form onSubmit={handleRequestOtp} className="space-y-4">
            <div>
              <label className="block text-xs font-medium text-zinc-300 mb-1.5">
                Phone Number (e.g. 0712345678 or +254...)
              </label>
              <div className="relative">
                <Phone className="w-4 h-4 text-zinc-500 absolute left-3 top-3.5" />
                <input
                  type="tel"
                  placeholder="0712 345 678"
                  value={phoneNumber}
                  onChange={(e) => setPhoneNumber(e.target.value)}
                  className="w-full bg-zinc-950 border border-zinc-800 focus:border-red-500 focus:ring-1 focus:ring-red-500 rounded-xl pl-10 pr-4 py-3 text-sm text-white placeholder-zinc-500 outline-none transition"
                  required
                />
              </div>
            </div>

            <div>
              <label className="block text-xs font-medium text-zinc-300 mb-1.5">
                Your Name <span className="text-zinc-500">(Optional)</span>
              </label>
              <div className="relative">
                <UserIcon className="w-4 h-4 text-zinc-500 absolute left-3 top-3.5" />
                <input
                  type="text"
                  placeholder="e.g. Kelvin Kimani"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  className="w-full bg-zinc-950 border border-zinc-800 focus:border-red-500 focus:ring-1 focus:ring-red-500 rounded-xl pl-10 pr-4 py-3 text-sm text-white placeholder-zinc-500 outline-none transition"
                />
              </div>
            </div>

            <button
              type="submit"
              disabled={loading}
              className="w-full mt-2 bg-red-600 hover:bg-red-500 disabled:opacity-50 text-white font-medium py-3 px-4 rounded-xl flex items-center justify-center space-x-2 transition shadow-lg shadow-red-950/50"
            >
              <span>{loading ? 'Sending Code...' : 'Send Verification Code'}</span>
              <ArrowRight className="w-4 h-4" />
            </button>
          </form>
        ) : (
          <form onSubmit={handleVerifyOtp} className="space-y-4">
            {devOtpCode && (
              <div role="status" className="p-3 rounded-xl border border-amber-700 bg-amber-950/40 text-amber-200 text-sm text-center">
                Staging OTP: <span className="font-mono font-bold tracking-widest text-base">{devOtpCode}</span>
              </div>
            )}

            <div>
              <div className="flex justify-between items-center mb-1.5">
                <label className="block text-xs font-medium text-zinc-300">
                  Enter 6-Digit Code sent to {phoneNumber}
                </label>
                <button
                  type="button"
                  onClick={() => setStep('phone')}
                  className="text-xs text-zinc-400 hover:text-zinc-200 underline"
                >
                  Change phone
                </button>
              </div>

              <div className="relative">
                <KeyRound className="w-4 h-4 text-zinc-500 absolute left-3 top-3.5" />
                <input
                  type="text"
                  maxLength={6}
                  placeholder="123456"
                  value={otpCode}
                  onChange={(e) => setOtpCode(e.target.value.replace(/\D/g, ''))}
                  className="w-full bg-zinc-950 border border-zinc-800 focus:border-red-500 focus:ring-1 focus:ring-red-500 rounded-xl pl-10 pr-4 py-3 text-center tracking-widest text-lg font-mono text-white placeholder-zinc-600 outline-none transition"
                  autoFocus
                  required
                />
              </div>
            </div>

            <button
              type="submit"
              disabled={loading || otpCode.length < 6}
              className="w-full bg-red-600 hover:bg-red-500 disabled:opacity-50 text-white font-medium py-3 px-4 rounded-xl flex items-center justify-center space-x-2 transition shadow-lg shadow-red-950/50"
            >
              <span>{loading ? 'Verifying...' : 'Verify & Continue'}</span>
              <ArrowRight className="w-4 h-4" />
            </button>

            <div className="text-center pt-2">
              <button
                type="button"
                disabled={cooldown > 0 || loading}
                onClick={handleRequestOtp}
                className="text-xs text-zinc-400 hover:text-zinc-200 disabled:opacity-50 transition"
              >
                {cooldown > 0 ? `Resend code in ${cooldown}s` : 'Did not receive code? Resend'}
              </button>
            </div>
          </form>
        )}
      </div>

      {(isNative || showServer) && (
        <div className="w-full max-w-md mt-4">
          <button
            type="button"
            onClick={() => setShowServer((v) => !v)}
            className="text-xs text-zinc-400 hover:text-zinc-200 underline"
          >
            {showServer ? 'Hide server settings' : 'Server settings'}
          </button>
          {showServer && (
            <div className="mt-2 p-4 rounded-2xl bg-zinc-900 border border-zinc-800 space-y-3">
              <label className="block text-xs font-medium text-zinc-300">Server address</label>
              <input
                type="url"
                inputMode="url"
                autoCapitalize="none"
                autoCorrect="off"
                placeholder="https://your-tunnel.trycloudflare.com"
                value={serverUrl}
                onChange={(e) => {
                  setServerUrl(e.target.value);
                  setServerCheck(null);
                }}
                className="w-full bg-zinc-950 border border-zinc-800 focus:border-red-500 rounded-xl px-3 py-2.5 text-sm text-white placeholder-zinc-600 outline-none"
              />
              <button
                type="button"
                onClick={handleTestServer}
                disabled={checking}
                className="w-full bg-zinc-800 hover:bg-zinc-700 disabled:opacity-50 text-white text-sm font-medium py-2.5 rounded-xl transition"
              >
                {checking ? 'Testing...' : 'Test & save'}
              </button>
              {serverCheck && (
                <p className={`text-xs ${serverCheck.ok ? 'text-emerald-400' : 'text-red-300'}`}>{serverCheck.message}</p>
              )}
              <p className="text-[11px] text-zinc-500">
                Quick-tunnel addresses change every time cloudflared restarts. Paste the new one here, no rebuild needed.
              </p>
            </div>
          )}
        </div>
      )}

      <p className="text-xs text-zinc-500 mt-6 text-center max-w-sm">
        By continuing, you agree that SEAS is for urgent peer notification and cannot replace statutory emergency services.
      </p>
    </div>
  );
};
