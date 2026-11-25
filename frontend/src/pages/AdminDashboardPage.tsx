import React, { useState, useEffect, useRef } from 'react';
import { api, ApiError } from '../services/api';
import type { AdminUserDTO } from '../services/api';
import { Role } from '@seas/shared';
import { useAuth } from '../context/AuthContext';
import QRCode from 'qrcode';
import {
  AlertDTO,
  AlertDeliveryDTO,
  AuditLogDTO,
  AlertProcessingStatus,
  AlertResolutionStatus,
  DeliveryStatus,
} from '@seas/shared';
import type { Socket } from 'socket.io-client';
import { connectSocket } from '../services/socket';
import * as tokenStore from '../services/tokenStore';
import {
  LayoutDashboard,
  ShieldAlert,
  ScrollText,
  Filter,
  MapPin,
  MapPinOff,
  Eye,
  RefreshCw,
  KeyRound,
} from 'lucide-react';

type AdminDataSource = 'Local' | 'Hosted' | 'Both';
type Sourced<T> = T & { source: AdminDataSource };
type SourceError = { source: Exclude<AdminDataSource, 'Both'>; message: string };

async function loadFromBoth<T>(
  loadLocal: () => Promise<T[]>,
  loadHosted: () => Promise<T[]>
): Promise<{ local: T[]; hosted: T[]; errors: SourceError[]; hostedAuthRequired: boolean }> {
  const [localResult, hostedResult] = await Promise.allSettled([
    api.ensureFreshSession().then(loadLocal),
    api.ensureFreshHostedAdminSession().then(loadHosted),
  ]);
  const errors: SourceError[] = [];
  let hostedAuthRequired = false;

  if (localResult.status === 'rejected') {
    errors.push({
      source: 'Local',
      message: localResult.reason instanceof Error ? localResult.reason.message : String(localResult.reason),
    });
  }
  if (hostedResult.status === 'rejected') {
    hostedAuthRequired =
      hostedResult.reason instanceof ApiError &&
      (hostedResult.reason.status === 401 ||
        hostedResult.reason.code === 'HOSTED_LOGIN_REQUIRED' ||
        hostedResult.reason.code === 'ADMIN_MFA_REQUIRED');
    errors.push({
      source: 'Hosted',
      message: hostedResult.reason instanceof Error ? hostedResult.reason.message : String(hostedResult.reason),
    });
  }

  return {
    local: localResult.status === 'fulfilled' ? localResult.value : [],
    hosted: hostedResult.status === 'fulfilled' ? hostedResult.value : [],
    errors,
    hostedAuthRequired,
  };
}

function mergeById<T extends { id: string }>(local: T[], hosted: T[]): Sourced<T>[] {
  const records = new Map<string, Sourced<T>>();
  local.forEach((record) => records.set(record.id, { ...record, source: 'Local' }));
  hosted.forEach((record) => {
    const existing = records.get(record.id);
    if (existing) {
      existing.source = 'Both';
    } else {
      records.set(record.id, { ...record, source: 'Hosted' });
    }
  });
  return Array.from(records.values());
}

export const AdminDashboardPage: React.FC = () => {
  const { user } = useAuth();
  const [activeTab, setActiveTab] = useState<'alerts' | 'users' | 'audit'>('alerts');
  const [alerts, setAlerts] = useState<Sourced<AlertDTO>[]>([]);
  const [users, setUsers] = useState<Sourced<AdminUserDTO>[]>([]);
  const [auditLogs, setAuditLogs] = useState<Sourced<AuditLogDTO>[]>([]);
  const [loading, setLoading] = useState(true);
  const [sourceErrors, setSourceErrors] = useState<SourceError[]>([]);

  // Filters
  const [statusFilter, setStatusFilter] = useState<string>('');
  const [resolutionFilter, setResolutionFilter] = useState<string>('');
  const [selectedAlert, setSelectedAlert] = useState<Sourced<AlertDTO> | null>(null);
  const [hostedConnected, setHostedConnected] = useState(api.hasHostedAdminSession());
  const [hostedStep, setHostedStep] = useState<'phone' | 'otp' | 'mfa'>('phone');
  const [hostedPhone, setHostedPhone] = useState(user?.phoneNumber || '');
  const [hostedOtp, setHostedOtp] = useState('');
  const [hostedMfaCode, setHostedMfaCode] = useState('');
  const [hostedDevOtp, setHostedDevOtp] = useState<string | null>(null);
  const [hostedPendingSession, setHostedPendingSession] = useState<{ accessToken: string; refreshToken: string } | null>(null);
  const [hostedMfaSecret, setHostedMfaSecret] = useState('');
  const [hostedMfaQr, setHostedMfaQr] = useState('');
  const [hostedNeedsMfaSetup, setHostedNeedsMfaSetup] = useState(false);
  const [hostedAuthError, setHostedAuthError] = useState('');
  const [hostedAuthLoading, setHostedAuthLoading] = useState(false);
  const [hostedSessionVersion, setHostedSessionVersion] = useState(0);

  const socketRef = useRef<Socket | null>(null);

  const fetchAlerts = async () => {
    setLoading(true);
    setSourceErrors([]);
    const filters = {
      status: statusFilter || undefined,
      resolutionStatus: resolutionFilter || undefined,
    };
    const result = await loadFromBoth(
      () => api.getAdminAlerts(filters),
      () => api.getHostedAdminAlerts(filters)
    );
    if (result.hostedAuthRequired) {
      api.clearHostedAdminSession();
      setHostedConnected(false);
    }
    setAlerts(mergeById(result.local, result.hosted));
    setSourceErrors(result.errors);
    setLoading(false);
  };

  const fetchUsers = async () => {
    setLoading(true);
    setSourceErrors([]);
    const result = await loadFromBoth(() => api.getAdminUsers(), () => api.getHostedAdminUsers());
    if (result.hostedAuthRequired) {
      api.clearHostedAdminSession();
      setHostedConnected(false);
    }
    setUsers(mergeById(result.local, result.hosted));
    setSourceErrors(result.errors);
    setLoading(false);
  };

  const fetchAuditLogs = async () => {
    setLoading(true);
    setSourceErrors([]);
    const result = await loadFromBoth(() => api.getAdminAuditLogs(), () => api.getHostedAdminAuditLogs());
    if (result.hostedAuthRequired) {
      api.clearHostedAdminSession();
      setHostedConnected(false);
    }
    setAuditLogs(mergeById(result.local, result.hosted));
    setSourceErrors(result.errors);
    setLoading(false);
  };

  useEffect(() => {
    if (activeTab === 'alerts') fetchAlerts();
    if (activeTab === 'users') fetchUsers();
    if (activeTab === 'audit') fetchAuditLogs();
  }, [activeTab, statusFilter, resolutionFilter, hostedSessionVersion]);

  const requestHostedOtp = async (event: React.FormEvent) => {
    event.preventDefault();
    setHostedAuthLoading(true);
    setHostedAuthError('');
    try {
      const result = await api.requestHostedAdminOtp(hostedPhone.trim());
      setHostedDevOtp(result.devCode ?? null);
      setHostedOtp(result.devCode ?? '');
      setHostedStep('otp');
    } catch (error) {
      setHostedAuthError(error instanceof Error ? error.message : String(error));
    } finally {
      setHostedAuthLoading(false);
    }
  };

  const verifyHostedOtp = async (event: React.FormEvent) => {
    event.preventDefault();
    setHostedAuthLoading(true);
    setHostedAuthError('');
    try {
      const session = await api.verifyHostedAdminOtp(hostedPhone.trim(), hostedOtp.trim());
      if (session.user.role !== Role.ADMIN) {
        await api.revokeHostedSession(session.refreshToken);
        setHostedStep('phone');
        setHostedAuthError('This phone number is not an administrator on the hosted server.');
        return;
      }
      setHostedPendingSession({ accessToken: session.accessToken, refreshToken: session.refreshToken });
      setHostedNeedsMfaSetup(false);
      setHostedStep('mfa');
    } catch (error) {
      setHostedAuthError(error instanceof Error ? error.message : String(error));
    } finally {
      setHostedAuthLoading(false);
    }
  };

  const setupHostedMfa = async () => {
    if (!hostedPendingSession) return;
    setHostedAuthLoading(true);
    setHostedAuthError('');
    try {
      const result = await api.setupHostedAdminMfa(hostedPendingSession.accessToken);
      setHostedMfaSecret(result.secret);
      setHostedMfaQr(await QRCode.toDataURL(result.otpauth, { errorCorrectionLevel: 'M', margin: 2, width: 220 }));
      setHostedNeedsMfaSetup(true);
    } catch (error) {
      setHostedAuthError(error instanceof Error ? error.message : String(error));
    } finally {
      setHostedAuthLoading(false);
    }
  };

  const verifyHostedMfa = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!hostedPendingSession) return;
    setHostedAuthLoading(true);
    setHostedAuthError('');
    try {
      await api.verifyHostedAdminMfa(
        hostedMfaCode.trim(),
        hostedPendingSession.accessToken,
        hostedPendingSession.refreshToken
      );
      setHostedConnected(true);
      setHostedPendingSession(null);
      setHostedMfaCode('');
      setHostedMfaQr('');
      setHostedMfaSecret('');
      setHostedSessionVersion((version) => version + 1);
    } catch (error: any) {
      setHostedAuthError(error instanceof Error ? error.message : String(error));
      if (error?.code === 'ADMIN_MFA_SETUP_REQUIRED') setHostedNeedsMfaSetup(true);
    } finally {
      setHostedAuthLoading(false);
    }
  };

  const disconnectHosted = async () => {
    setHostedAuthLoading(true);
    setHostedAuthError('');
    try {
      await api.logoutHostedAdmin();
    } catch (error) {
      setHostedAuthError(error instanceof Error ? error.message : String(error));
    } finally {
      setHostedConnected(false);
      setHostedSessionVersion((version) => version + 1);
      setHostedAuthLoading(false);
    }
  };

  // Realtime Socket.io wiring
  useEffect(() => {
    const token = tokenStore.getItem('seas_access_token');
    if (token) {
      const socket = connectSocket(token);
      socketRef.current = socket;

      socket.emit('join:admin');

      socket.on('alert:new', (newAlert: AlertDTO) => {
        setAlerts((prev) => {
          const existing = prev.find((alert) => alert.id === newAlert.id);
          const source: AdminDataSource = existing ? 'Both' : 'Local';
          return [{ ...newAlert, source }, ...prev.filter((alert) => alert.id !== newAlert.id)];
        });
      });

      socket.on('alert:delivery-updated', ({ alertId, delivery }: { alertId: string; delivery: AlertDeliveryDTO }) => {
        setAlerts((prev) =>
          prev.map((a) => {
            if (a.id !== alertId) return a;
            return {
              ...a,
              deliveries: a.deliveries.map((d) => (d.id === delivery.id ? delivery : d)),
            };
          })
        );
        setSelectedAlert((curr) => {
          if (!curr || curr.id !== alertId) return curr;
          return {
            ...curr,
            deliveries: curr.deliveries.map((d) => (d.id === delivery.id ? delivery : d)),
          };
        });
      });

      socket.on('alert:resolution-updated', (updatedAlert: AlertDTO) => {
        setAlerts((prev) =>
          prev.map((alert) => (alert.id === updatedAlert.id ? { ...updatedAlert, source: alert.source } : alert))
        );
        setSelectedAlert((curr) =>
          curr?.id === updatedAlert.id ? { ...updatedAlert, source: curr.source } : curr
        );
      });

      return () => {
        socket.disconnect();
      };
    }
  }, []);

  return (
    <div className="max-w-6xl mx-auto px-4 py-8">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between pb-6 border-b border-zinc-800 gap-4">
        <div>
          <h1 className="text-2xl font-bold text-white flex items-center space-x-2.5">
            <LayoutDashboard className="w-6 h-6 text-red-500" />
            <span>Emergency Operations Dashboard</span>
          </h1>
          <p className="text-sm text-zinc-400 mt-1">
            Combined local and hosted monitoring for emergency alerts, delivery reports and audit records.
          </p>
        </div>

        {/* Tab Buttons */}
        <div className="flex items-center space-x-2 bg-zinc-900 p-1 rounded-xl border border-zinc-800">
          <button
            onClick={() => setActiveTab('alerts')}
            className={`px-3 py-1.5 rounded-lg text-xs font-medium transition ${
              activeTab === 'alerts' ? 'bg-red-600 text-white shadow' : 'text-zinc-400 hover:text-white'
            }`}
          >
            Live Alerts ({alerts.length})
          </button>
          <button
            onClick={() => setActiveTab('users')}
            className={`px-3 py-1.5 rounded-lg text-xs font-medium transition ${
              activeTab === 'users' ? 'bg-red-600 text-white shadow' : 'text-zinc-400 hover:text-white'
            }`}
          >
            Users & Contacts
          </button>
          <button
            onClick={() => setActiveTab('audit')}
            className={`px-3 py-1.5 rounded-lg text-xs font-medium transition ${
              activeTab === 'audit' ? 'bg-red-600 text-white shadow' : 'text-zinc-400 hover:text-white'
            }`}
          >
            Audit Log
          </button>
        </div>
      </div>

      <section className="mt-6 rounded-2xl border border-zinc-800 bg-zinc-900 p-4 sm:p-5 space-y-4">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h2 className="font-semibold text-white">Hosted server access</h2>
            <p className="mt-1 text-xs text-zinc-400">
              Local and hosted servers use separate accounts and sessions. Connect with an administrator registered on Render to view alerts sent from phones.
            </p>
          </div>
          {hostedConnected && (
            <button
              type="button"
              onClick={disconnectHosted}
              disabled={hostedAuthLoading}
              className="self-start rounded-lg bg-zinc-800 px-3 py-2 text-xs text-zinc-200 hover:bg-zinc-700 disabled:opacity-50 sm:self-auto"
            >
              {hostedAuthLoading ? 'Disconnecting...' : 'Disconnect hosted server'}
            </button>
          )}
        </div>

        {hostedConnected ? (
          <p role="status" className="text-sm text-emerald-400">Hosted administrator session connected.</p>
        ) : hostedPendingSession ? (
          <form onSubmit={verifyHostedMfa} className="max-w-xl space-y-3">
            <p className="text-sm text-zinc-300">
              {hostedNeedsMfaSetup
                ? 'Hosted authenticator setup is required. Scan the QR code below, then enter its 6-digit code.'
                : 'Enter the 6-digit code from the authenticator registered on the hosted server.'}
            </p>
            {hostedDevOtp && <p className="text-xs text-amber-300">Hosted staging OTP: <span className="font-mono font-bold">{hostedDevOtp}</span></p>}
            <div className="flex flex-wrap gap-2">
              <input
                type="text"
                inputMode="numeric"
                autoComplete="one-time-code"
                maxLength={6}
                value={hostedMfaCode}
                onChange={(event) => setHostedMfaCode(event.target.value.replace(/\D/g, '').slice(0, 6))}
                placeholder="6-digit authenticator code"
                className="min-w-52 flex-1 rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm text-white"
              />
              <button
                type="submit"
                disabled={hostedAuthLoading || hostedMfaCode.length !== 6}
                className="rounded-lg bg-emerald-700 px-4 py-2 text-sm text-white hover:bg-emerald-600 disabled:opacity-50"
              >
                {hostedAuthLoading ? 'Verifying...' : 'Verify & connect'}
              </button>
            </div>
            <button
              type="button"
              onClick={setupHostedMfa}
              disabled={hostedAuthLoading}
              className="flex items-center gap-2 rounded-lg bg-zinc-800 px-3 py-2 text-xs text-zinc-200 hover:bg-zinc-700 disabled:opacity-50"
            >
              <KeyRound className="h-4 w-4" />
              Set up or reset hosted authenticator
            </button>
            <p className="text-xs text-amber-300">
              Only set up/reset if you cannot use the existing hosted authenticator. Resetting replaces its secret.
            </p>
            {hostedMfaQr && (
              <div className="inline-flex flex-col items-center gap-2 rounded-xl bg-white p-3">
                <img src={hostedMfaQr} alt="Hosted server authenticator setup QR code" width={220} height={220} />
                <span className="text-xs text-zinc-700">Scan this hosted-server QR code</span>
              </div>
            )}
            {hostedMfaSecret && (
              <p className="break-all text-xs text-zinc-400">
                Manual setup key: <span className="font-mono text-zinc-200">{hostedMfaSecret}</span>
              </p>
            )}
          </form>
        ) : (
          <form onSubmit={hostedStep === 'phone' ? requestHostedOtp : verifyHostedOtp} className="max-w-xl space-y-3">
            {hostedStep === 'phone' ? (
              <>
                <label className="block text-xs font-medium text-zinc-300" htmlFor="hosted-admin-phone">Hosted admin phone number</label>
                <div className="flex flex-wrap gap-2">
                  <input
                    id="hosted-admin-phone"
                    type="tel"
                    autoComplete="tel"
                    value={hostedPhone}
                    onChange={(event) => setHostedPhone(event.target.value)}
                    placeholder="+254..."
                    required
                    className="min-w-52 flex-1 rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm text-white"
                  />
                  <button
                    type="submit"
                    disabled={hostedAuthLoading || !hostedPhone.trim()}
                    className="rounded-lg bg-red-700 px-4 py-2 text-sm text-white hover:bg-red-600 disabled:opacity-50"
                  >
                    {hostedAuthLoading ? 'Sending...' : 'Send hosted OTP'}
                  </button>
                </div>
              </>
            ) : (
              <>
                <label className="block text-xs font-medium text-zinc-300" htmlFor="hosted-admin-otp">
                  Enter the hosted-server OTP sent to {hostedPhone}
                </label>
                <div className="flex flex-wrap gap-2">
                  <input
                    id="hosted-admin-otp"
                    type="text"
                    inputMode="numeric"
                    autoComplete="one-time-code"
                    value={hostedOtp}
                    onChange={(event) => setHostedOtp(event.target.value.replace(/\D/g, '').slice(0, 6))}
                    required
                    className="min-w-52 flex-1 rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm text-white"
                  />
                  <button
                    type="submit"
                    disabled={hostedAuthLoading || hostedOtp.length !== 6}
                    className="rounded-lg bg-red-700 px-4 py-2 text-sm text-white hover:bg-red-600 disabled:opacity-50"
                  >
                    {hostedAuthLoading ? 'Checking...' : 'Continue to MFA'}
                  </button>
                  <button
                    type="button"
                    onClick={() => { setHostedStep('phone'); setHostedOtp(''); setHostedDevOtp(null); }}
                    className="rounded-lg bg-zinc-800 px-3 py-2 text-xs text-zinc-200 hover:bg-zinc-700"
                  >
                    Change number
                  </button>
                </div>
                {hostedDevOtp && <p className="text-xs text-amber-300">Hosted staging OTP: <span className="font-mono font-bold">{hostedDevOtp}</span></p>}
              </>
            )}
          </form>
        )}

        {hostedAuthError && <p role="alert" className="text-sm text-red-300">{hostedAuthError}</p>}
      </section>

      {sourceErrors.length > 0 && (
        <div role="alert" className="mt-6 p-4 rounded-xl bg-red-950/60 border border-red-800 text-red-200 text-sm space-y-1">
          {sourceErrors.map((sourceError) => (
            <p key={sourceError.source}>{sourceError.source} source unavailable: {sourceError.message}</p>
          ))}
        </div>
      )}

      {/* ALERTS TAB */}
      {activeTab === 'alerts' && (
        <div className="mt-6">
          {/* Filters Bar */}
          <div className="bg-zinc-900 border border-zinc-800 rounded-2xl p-4 mb-6 flex flex-wrap items-center justify-between gap-4">
            <div className="flex flex-wrap items-center gap-3">
              <div className="flex items-center space-x-1.5 text-xs text-zinc-400">
                <Filter className="w-3.5 h-3.5" />
                <span>Filters:</span>
              </div>

              <select
                value={statusFilter}
                onChange={(e) => setStatusFilter(e.target.value)}
                className="bg-zinc-950 border border-zinc-800 rounded-lg px-3 py-1.5 text-xs text-zinc-300 outline-none"
              >
                <option value="">All Processing States</option>
                <option value={AlertProcessingStatus.CREATED}>CREATED</option>
                <option value={AlertProcessingStatus.PROCESSING}>PROCESSING</option>
                <option value={AlertProcessingStatus.COMPLETED}>COMPLETED</option>
              </select>

              <select
                value={resolutionFilter}
                onChange={(e) => setResolutionFilter(e.target.value)}
                className="bg-zinc-950 border border-zinc-800 rounded-lg px-3 py-1.5 text-xs text-zinc-300 outline-none"
              >
                <option value="">All Resolution States</option>
                <option value={AlertResolutionStatus.OPEN}>OPEN (Active)</option>
                <option value={AlertResolutionStatus.RESOLVED}>RESOLVED</option>
                <option value={AlertResolutionStatus.CANCELLED}>CANCELLED</option>
              </select>
            </div>

            <button
              onClick={fetchAlerts}
              className="p-2 text-zinc-400 hover:text-white hover:bg-zinc-800 rounded-lg transition"
              title="Refresh alerts"
            >
              <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
            </button>
          </div>

          {/* Alerts Feed */}
          {loading && alerts.length === 0 ? (
            <div className="text-center py-12 text-zinc-500 text-sm">Loading live alerts...</div>
          ) : alerts.length === 0 ? (
            <div className="text-center py-16 bg-zinc-900/50 border border-zinc-800/80 rounded-2xl text-zinc-400 text-sm">
              No emergency alerts found in the available sources for the selected filters.
            </div>
          ) : (
            <div className="space-y-4">
              {alerts.map((alert) => {
                const isOpen = alert.resolutionStatus === AlertResolutionStatus.OPEN;
                return (
                  <div
                    key={alert.id}
                    className={`bg-zinc-900 rounded-2xl p-5 border transition ${
                      isOpen
                        ? 'border-red-900/80 shadow-lg shadow-red-950/20'
                        : 'border-zinc-800/80 hover:border-zinc-700'
                    }`}
                  >
                    <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                      <div className="flex items-start space-x-3.5">
                        <div
                          className={`p-2.5 rounded-xl shrink-0 mt-0.5 ${
                            isOpen ? 'bg-red-500/20 text-red-400 border border-red-500/30' : 'bg-zinc-800 text-zinc-400'
                          }`}
                        >
                          <ShieldAlert className="w-5 h-5" />
                        </div>
                        <div>
                          <div className="flex items-center space-x-2">
                            <h3 className="font-bold text-white text-base">
                              {alert.user?.name || 'Unknown User'}
                            </h3>
                            <span className="rounded bg-zinc-800 px-2 py-0.5 text-[10px] text-zinc-300">{alert.source}</span>
                            <span className="text-xs text-zinc-400 font-mono">
                              ({alert.user?.phoneNumber || 'No phone'})
                            </span>
                            {alert.delayed && (
                              <span className="px-2 py-0.5 rounded bg-amber-500/20 text-amber-400 border border-amber-500/30 text-[10px] font-semibold">
                                Delayed Alert
                              </span>
                            )}
                          </div>

                          <div className="flex flex-wrap items-center gap-3 text-xs text-zinc-400 mt-1.5 font-mono">
                            <span>Triggered: {new Date(alert.triggeredAt).toLocaleString()}</span>
                            <span>•</span>
                            <span className="flex items-center space-x-1">
                              {alert.locationAvailable ? (
                                <>
                                  <MapPin className="w-3.5 h-3.5 text-emerald-400" />
                                  <span className="text-emerald-400">
                                    {alert.latitude?.toFixed(4)}, {alert.longitude?.toFixed(4)}
                                  </span>
                                </>
                              ) : (
                                <>
                                  <MapPinOff className="w-3.5 h-3.5 text-amber-400" />
                                  <span className="text-amber-400">Location Unavailable</span>
                                </>
                              )}
                            </span>
                          </div>
                        </div>
                      </div>

                      <div className="flex items-center space-x-2 sm:self-center">
                        <span
                          className={`px-2.5 py-1 rounded-full text-xs font-semibold ${
                            alert.resolutionStatus === AlertResolutionStatus.OPEN
                              ? 'bg-red-500/20 text-red-400 border border-red-500/30'
                              : alert.resolutionStatus === AlertResolutionStatus.RESOLVED
                              ? 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/30'
                              : 'bg-zinc-800 text-zinc-400'
                          }`}
                        >
                          {alert.resolutionStatus}
                        </span>

                        <button
                          onClick={() => setSelectedAlert(alert)}
                          className="flex items-center space-x-1 bg-zinc-800 hover:bg-zinc-700 text-zinc-200 px-3 py-1.5 rounded-lg text-xs font-medium transition"
                        >
                          <Eye className="w-3.5 h-3.5" />
                          <span>Details</span>
                        </button>
                      </div>
                    </div>

                    {/* Delivery summary bar */}
                    <div className="mt-4 pt-3 border-t border-zinc-800/80 flex items-center justify-between text-xs text-zinc-400">
                      <span>
                        Recipients: {alert.deliveries.length} contacts notified
                      </span>
                      <div className="flex items-center space-x-3">
                        <span className="text-emerald-400 font-mono">
                          {alert.deliveries.filter((d) => d.status === DeliveryStatus.DELIVERED).length} Delivered
                        </span>
                        <span className="text-blue-400 font-mono">
                          {alert.deliveries.filter((d) => d.status === DeliveryStatus.SENT).length} Sent
                        </span>
                        <span className="text-red-400 font-mono">
                          {alert.deliveries.filter((d) => d.status === DeliveryStatus.FAILED).length} Failed
                        </span>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* USERS TAB */}
      {activeTab === 'users' && (
        <div className="mt-6 bg-zinc-900 border border-zinc-800 rounded-2xl overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm text-zinc-300">
              <thead className="bg-zinc-950 text-xs font-semibold text-zinc-400 uppercase tracking-wider border-b border-zinc-800">
                <tr>
                  <th className="px-6 py-4">Name</th>
                  <th className="px-6 py-4">Phone Number</th>
                  <th className="px-6 py-4">Role</th>
                  <th className="px-6 py-4">Contacts</th>
                  <th className="px-6 py-4">Alerts</th>
                  <th className="px-6 py-4">Registered</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-800">
                {loading && users.length === 0 ? (
                  <tr><td colSpan={6} className="px-6 py-10 text-center text-zinc-500">Loading users from both sources...</td></tr>
                ) : users.length === 0 ? (
                  <tr><td colSpan={6} className="px-6 py-10 text-center text-zinc-500">No users found in the available sources.</td></tr>
                ) : users.map((u) => (
                  <tr key={u.id} className="hover:bg-zinc-800/40 transition">
                    <td className="px-6 py-4 font-medium text-white">
                      {u.name}
                      <span className="ml-2 text-[10px] text-zinc-500">{u.source}</span>
                    </td>
                    <td className="px-6 py-4 font-mono">{u.phoneNumber}</td>
                    <td className="px-6 py-4">
                      <span
                        className={`px-2 py-0.5 rounded text-xs font-semibold ${
                          u.role === 'ADMIN' ? 'bg-purple-950 text-purple-300 border border-purple-800' : 'bg-zinc-800 text-zinc-400'
                        }`}
                      >
                        {u.role}
                      </span>
                    </td>
                    <td className="px-6 py-4">{u.contactsCount}</td>
                    <td className="px-6 py-4">{u.alertsCount}</td>
                    <td className="px-6 py-4 text-xs text-zinc-400">
                      {new Date(u.createdAt).toLocaleDateString()}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* AUDIT LOGS TAB */}
      {activeTab === 'audit' && (
        <div className="mt-6 bg-zinc-900 border border-zinc-800 rounded-2xl p-6">
          <h2 className="text-base font-semibold text-white mb-2 flex items-center space-x-2">
            <ScrollText className="w-5 h-5 text-zinc-400" />
            <span>Immutable Security Audit Log</span>
          </h2>
          <p className="text-xs text-zinc-400 mb-6">
            All administrative access and privileged role actions are permanently recorded here without storing raw emergency locations.
          </p>

          <div className="space-y-3 font-mono text-xs">
            {loading && auditLogs.length === 0 ? (
              <p className="py-8 text-center text-zinc-500">Loading audit logs from both sources...</p>
            ) : auditLogs.length === 0 ? (
              <p className="py-8 text-center text-zinc-500">No audit records found in the available sources.</p>
            ) : auditLogs.map((log) => (
              <div
                key={log.id}
                className="p-3 rounded-xl bg-zinc-950 border border-zinc-800/80 flex items-center justify-between"
              >
                <div>
                  <span className="text-red-400 font-semibold">{log.action}</span>
                  <span className="text-zinc-500 ml-3">Actor: {log.actorId || 'SYSTEM'}</span>
                  <span className="text-zinc-500 ml-3">Source: {log.source}</span>
                </div>
                <span className="text-zinc-500">{new Date(log.createdAt).toLocaleString()}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Alert Drilldown Modal */}
      {selectedAlert && (
        <div className="fixed inset-0 bg-black/80 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div className="bg-zinc-900 border border-zinc-800 rounded-3xl max-w-2xl w-full p-6 sm:p-8 max-h-[90vh] overflow-y-auto shadow-2xl">
            <div className="flex items-center justify-between pb-4 border-b border-zinc-800">
              <h2 className="text-lg font-bold text-white flex items-center space-x-2">
                <ShieldAlert className="w-5 h-5 text-red-500" />
                <span>Alert Incident Drilldown</span>
              </h2>
              <button
                onClick={() => setSelectedAlert(null)}
                className="text-zinc-400 hover:text-white px-2 py-1 rounded-lg text-sm"
              >
                ✕
              </button>
            </div>

            <div className="mt-4 space-y-4">
              <div className="grid grid-cols-2 gap-3 text-xs">
                <div className="bg-zinc-950 p-3 rounded-xl border border-zinc-800">
                  <span className="text-zinc-500 block">Triggered At</span>
                  <span className="font-mono text-white">
                    {new Date(selectedAlert.triggeredAt).toLocaleString()}
                  </span>
                </div>
                <div className="bg-zinc-950 p-3 rounded-xl border border-zinc-800">
                  <span className="text-zinc-500 block">Processing Status</span>
                  <span className="font-mono text-white">{selectedAlert.status}</span>
                </div>
              </div>

              {/* Coordinates Block */}
              <div className="bg-zinc-950 p-4 rounded-xl border border-zinc-800">
                <span className="text-xs text-zinc-500 block mb-1">Geographic Coordinates</span>
                {selectedAlert.locationAvailable && selectedAlert.latitude != null && selectedAlert.longitude != null ? (
                  <div>
                    <span className="font-mono text-emerald-400 text-sm">
                      {selectedAlert.latitude}, {selectedAlert.longitude}
                    </span>
                    <a
                      href={`https://maps.google.com/?q=${selectedAlert.latitude},${selectedAlert.longitude}`}
                      target="_blank"
                      rel="noreferrer"
                      className="block mt-2 text-xs text-red-400 hover:underline"
                    >
                      Open in External Map Provider →
                    </a>
                  </div>
                ) : (
                  <div className="flex items-center space-x-2 text-amber-400 text-xs">
                    <MapPinOff className="w-4 h-4" />
                    <span>Location Unavailable (Device denied permission or GPS timed out)</span>
                  </div>
                )}
              </div>

              {/* Deliveries */}
              <div>
                <h3 className="text-xs font-semibold text-zinc-400 uppercase tracking-wider mb-2">
                  SMS Deliveries Per Contact ({selectedAlert.deliveries.length})
                </h3>
                <div className="space-y-2">
                  {selectedAlert.deliveries.map((del) => (
                    <div
                      key={del.id}
                      className="p-3 bg-zinc-950 border border-zinc-800 rounded-xl flex items-center justify-between text-xs"
                    >
                      <div>
                        <div className="font-semibold text-white">{del.contactNameSnapshot}</div>
                        <div className="font-mono text-zinc-400 mt-0.5">{del.contactPhoneSnapshot}</div>
                      </div>
                      <div className="text-right">
                        <span
                          className={`inline-block px-2 py-0.5 rounded text-[11px] font-semibold ${
                            del.status === 'DELIVERED'
                              ? 'bg-emerald-950 text-emerald-400 border border-emerald-800'
                              : del.status === 'SENT'
                              ? 'bg-blue-950 text-blue-400 border border-blue-800'
                              : del.status === 'FAILED'
                              ? 'bg-red-950 text-red-400 border border-red-800'
                              : 'bg-zinc-800 text-zinc-400'
                          }`}
                        >
                          {del.status}
                        </span>
                        {del.lastErrorCode && (
                          <span className="block text-[10px] text-red-400 mt-1">{del.lastErrorCode}</span>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
