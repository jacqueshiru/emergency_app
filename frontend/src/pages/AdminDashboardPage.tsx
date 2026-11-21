import React, { useState, useEffect, useRef } from 'react';
import { api } from '../services/api';
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
} from 'lucide-react';

export const AdminDashboardPage: React.FC = () => {
  const [activeTab, setActiveTab] = useState<'alerts' | 'users' | 'audit'>('alerts');
  const [alerts, setAlerts] = useState<AlertDTO[]>([]);
  const [users, setUsers] = useState<any[]>([]);
  const [auditLogs, setAuditLogs] = useState<AuditLogDTO[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Filters
  const [statusFilter, setStatusFilter] = useState<string>('');
  const [resolutionFilter, setResolutionFilter] = useState<string>('');
  const [selectedAlert, setSelectedAlert] = useState<AlertDTO | null>(null);

  const socketRef = useRef<Socket | null>(null);

  const fetchAlerts = async () => {
    try {
      setLoading(true);
      setError(null);
      const data = await api.getAdminAlerts({
        status: statusFilter || undefined,
        resolutionStatus: resolutionFilter || undefined,
      });
      setAlerts(data);
    } catch (err: any) {
      setError(err.message || 'Failed to fetch admin alerts');
    } finally {
      setLoading(false);
    }
  };

  const fetchUsers = async () => {
    try {
      setLoading(true);
      const data = await api.getAdminUsers();
      setUsers(data);
    } catch (err: any) {
      setError(err.message || 'Failed to fetch users');
    } finally {
      setLoading(false);
    }
  };

  const fetchAuditLogs = async () => {
    try {
      setLoading(true);
      const data = await api.getAdminAuditLogs();
      setAuditLogs(data);
    } catch (err: any) {
      setError(err.message || 'Failed to fetch audit logs');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (activeTab === 'alerts') fetchAlerts();
    if (activeTab === 'users') fetchUsers();
    if (activeTab === 'audit') fetchAuditLogs();
  }, [activeTab, statusFilter, resolutionFilter]);

  // Realtime Socket.io wiring
  useEffect(() => {
    const token = tokenStore.getItem('seas_access_token');
    if (token) {
      const socket = connectSocket(token);
      socketRef.current = socket;

      socket.emit('join:admin');

      socket.on('alert:new', (newAlert: AlertDTO) => {
        setAlerts((prev) => [newAlert, ...prev.filter((a) => a.id !== newAlert.id)]);
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
        setAlerts((prev) => prev.map((a) => (a.id === updatedAlert.id ? updatedAlert : a)));
        setSelectedAlert((curr) => (curr?.id === updatedAlert.id ? updatedAlert : curr));
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
            Realtime monitoring room for emergency alerts, delivery reports and audit records.
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

      {error && (
        <div className="mt-6 p-4 rounded-xl bg-red-950/60 border border-red-800 text-red-200 text-sm">
          {error}
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
              No emergency alerts found for the selected filters.
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
                {users.map((u) => (
                  <tr key={u.id} className="hover:bg-zinc-800/40 transition">
                    <td className="px-6 py-4 font-medium text-white">{u.name}</td>
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
            {auditLogs.map((log) => (
              <div
                key={log.id}
                className="p-3 rounded-xl bg-zinc-950 border border-zinc-800/80 flex items-center justify-between"
              >
                <div>
                  <span className="text-red-400 font-semibold">{log.action}</span>
                  <span className="text-zinc-500 ml-3">Actor: {log.actorId || 'SYSTEM'}</span>
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
