import React, { useState, useEffect, useRef } from 'react';
import { api, ApiError } from '../services/api';
import { offlineQueue } from '../services/offlineQueue';
import {
  AlertDTO,
  AlertDeliveryDTO,
  AlertProcessingStatus,
  CreateAlertDTO,
  DeliveryStatus,
  DeviceDeliveryReportDTO,
  AlertResolutionStatus,
} from '@seas/shared';
import type { Socket } from 'socket.io-client';
import { connectSocket } from '../services/socket';
import { getPosition, confirmHaptic, onReconnect, onResume } from '../services/platform';
import * as tokenStore from '../services/tokenStore';
import { useAuth } from '../context/AuthContext';
import { loadContacts, saveContacts, type CachedContact } from '../services/contactsCache';
import {
  onSmsDelivery,
  openVolumeSosAccessibilitySettings,
  smsSender,
  smsSenderSupported,
  volumeSosAccessibilityEnabled,
  type SmsDeliveryEvent,
} from '../services/smsSender';
import { setVolumeSosHandler } from '../services/volumeSosBridge';
import {
  initDeviceSms,
  sendSosFromDevice,
  buildSosMessage,
  TEST_MODE,
  DEVICE_ID_SEPARATOR,
  type DeviceSmsState,
} from '../services/deviceSms';
import {
  ShieldAlert,
  MapPin,
  MapPinOff,
  Clock,
  CheckCircle2,
  AlertTriangle,
  Check,
  Send,
  Loader2,
  Phone,
  WifiOff,
} from 'lucide-react';

const HOLD_DURATION_MS = 1500; // 1.5s hold to confirm
const GPS_TIMEOUT_MS = 8000;
const GPS_POOR_ACCURACY_M = 100;

interface LocalAlertInput {
  idempotencyKey: string;
  latitude?: number | null;
  longitude?: number | null;
  accuracy?: number | null;
  locationAvailable: boolean;
  triggeredAt?: string;
  deviceDeliveries?: DeviceDeliveryReportDTO[];
}

/**
 * An alert that exists only on this phone so far (texts already sent, server record pending).
 * Its id starts with "local:"; it is replaced by the server's alert after syncing.
 * With no results yet every contact shows as PENDING (sending in progress).
 */
function buildLocalAlert(input: LocalAlertInput, contacts: CachedContact[], userId: string): AlertDTO {
  const now = new Date().toISOString();
  const results = new Map((input.deviceDeliveries ?? []).map((d) => [d.contactId, d]));
  const id = `local:${input.idempotencyKey}`;
  return {
    id,
    userId,
    idempotencyKey: input.idempotencyKey,
    latitude: input.latitude ?? null,
    longitude: input.longitude ?? null,
    accuracy: input.accuracy ?? null,
    locationAvailable: input.locationAvailable,
    triggeredAt: input.triggeredAt ?? now,
    delayed: false,
    status: AlertProcessingStatus.PROCESSING,
    resolutionStatus: AlertResolutionStatus.OPEN,
    resolvedAt: null,
    deliveries: contacts.map((c) => {
      const r = results.get(c.id);
      return {
        id: `${input.idempotencyKey}${DEVICE_ID_SEPARATOR}${c.id}`,
        alertId: id,
        contactId: c.id,
        contactNameSnapshot: c.name,
        contactPhoneSnapshot: c.phoneNumber,
        relationshipSnapshot: c.relationship,
        channel: 'device-sms',
        status: r ? (r.status as DeliveryStatus) : DeliveryStatus.PENDING,
        providerMessageId: null,
        lastErrorCode: r?.error ?? null,
        attempts: r ? 1 : 0,
        lastAttemptAt: r ? now : null,
        nextRetryAt: null,
        updatedAt: now,
      };
    }),
  };
}

export const SosPage: React.FC = () => {
  const { user } = useAuth();
  const [activeAlert, setActiveAlert] = useState<AlertDTO | null>(null);
  const [queuedAlerts, setQueuedAlerts] = useState<any[]>([]);
  const [locationStatus, setLocationStatus] = useState<'prompt' | 'acquired' | 'unavailable'>('prompt');
  const [coords, setCoords] = useState<{ latitude: number | null; longitude: number | null; accuracy: number | null }>({
    latitude: null,
    longitude: null,
    accuracy: null,
  });
  // Immediate acknowledgement that the hold gesture registered (before any network result).
  const [registered, setRegistered] = useState(false);
  const processingQueue = useRef(false);
  // Synchronous guard against a second SOS starting before React has re-rendered `loading`.
  const triggerInFlight = useRef(false);

  // Texting from this phone's SIM (Android app). 'unsupported' in a browser.
  const [deviceSmsState, setDeviceSmsState] = useState<DeviceSmsState>('checking');
  const [infoMessage, setInfoMessage] = useState<string | null>(null);
  const activeAlertRef = useRef<AlertDTO | null>(null);
  // Carrier delivery reports that arrived before the alert was recorded on the server.
  const lateReportsRef = useRef<Map<string, DeviceDeliveryReportDTO[]>>(new Map());

  // Hold gesture state
  const [holding, setHolding] = useState(false);
  const [holdProgress, setHoldProgress] = useState(0); // 0 to 100
  const holdStartTime = useRef<number | null>(null);
  const holdAnimFrame = useRef<number | null>(null);

  const [loading, setLoading] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const socketRef = useRef<Socket | null>(null);
  const [volumeSosEnabled, setVolumeSosEnabled] = useState(false);

  useEffect(() => {
    activeAlertRef.current = activeAlert;
  }, [activeAlert]);

  // Ask for the SMS permission up front (never in the middle of an emergency), and keep the
  // on-phone copy of the contacts fresh whenever we are online.
  useEffect(() => {
    let active = true;
    initDeviceSms().then((state) => {
      if (active) setDeviceSmsState(state);
    });
    if (navigator.onLine) {
      api.getContacts().catch(() => {});
    }
    return () => {
      active = false;
    };
  }, []);

  // Carrier delivery reports for texts sent from this phone.
  useEffect(() => onSmsDelivery((e) => handleDeviceDelivery(e)), []);

  // Geolocation: bounded wait. A slow/denied fix must never block the SOS (it falls back to
  // locationAvailable: false). The JS timer also covers a permission prompt that stays open.
  useEffect(() => {
    let active = true;
    const fallback = setTimeout(() => {
      setLocationStatus((cur) => (cur === 'prompt' ? 'unavailable' : cur));
    }, GPS_TIMEOUT_MS + 1000);
    getPosition(GPS_TIMEOUT_MS, 10_000)
      .then((pos) => {
        if (!active) return;
        clearTimeout(fallback);
        setCoords({ latitude: pos.latitude, longitude: pos.longitude, accuracy: pos.accuracy });
        setLocationStatus('acquired');
      })
      .catch(() => {
        if (!active) return;
        clearTimeout(fallback);
        setLocationStatus('unavailable');
      });
    return () => {
      active = false;
      clearTimeout(fallback);
    };
  }, []);

  // Check offline queue and active alerts on mount
  useEffect(() => {
    checkOfflineQueue();
    fetchLatestAlert();

    // Setup Socket.io client
    const token = tokenStore.getItem('seas_access_token');
    if (token) {
      const socket = connectSocket(token);
      socketRef.current = socket;

      socket.on('alert:updated', (alert: AlertDTO) => {
        setActiveAlert((prev) => (prev?.id === alert.id ? alert : prev));
      });

      socket.on('alert:delivery-updated', ({ alertId, delivery }: { alertId: string; delivery: AlertDeliveryDTO }) => {
        setActiveAlert((prev) => {
          if (!prev || prev.id !== alertId) return prev;
          const updatedDeliveries = prev.deliveries.map((d) => (d.id === delivery.id ? delivery : d));
          return { ...prev, deliveries: updatedDeliveries };
        });
      });

      socket.on('alert:resolution-updated', (alert: AlertDTO) => {
        setActiveAlert((prev) => (prev?.id === alert.id ? alert : prev));
      });

      return () => {
        socket.disconnect();
      };
    }
  }, []);

  // Retry the queue on mount (a restart while already online must not strand entries), when the
  // network comes back, and when the app returns to the foreground.
  useEffect(() => {
    const run = () => {
      if (navigator.onLine) void processOfflineQueue();
    };
    run();
    const offReconnect = onReconnect(run);
    const offResume = onResume(run);
    return () => {
      offReconnect();
      offResume();
    };
  }, []);

  // Retry with backoff while an alert is waiting. Reconnect/resume events never fire when the phone
  // stayed "online" but the server was unreachable (503, timeout), so without this the alert would sit
  // in the queue until the user happened to switch apps.
  useEffect(() => {
    const next = queuedAlerts.find((q) => q.sentByDevice || q.confirmedAfterStale || !offlineQueue.isStale(q));
    if (!next) return;
    const delay = Math.min(60_000, 5_000 * 2 ** Math.min(next.attempts ?? 0, 4));
    const timer = setTimeout(() => {
      // Re-reading the queue re-arms this effect even when nothing was sent (still offline).
      if (navigator.onLine) void processOfflineQueue();
      else void checkOfflineQueue();
    }, delay);
    return () => clearTimeout(timer);
  }, [queuedAlerts]);

  const checkOfflineQueue = async () => {
    const queued = await offlineQueue.getAll();
    setQueuedAlerts(queued);
    // A phone-sent alert still waiting to be recorded: show it (e.g. after an app restart).
    const sentFromPhone = queued.find((q) => q.sentByDevice);
    if (sentFromPhone) {
      setActiveAlert((prev) => prev ?? buildLocalAlert(sentFromPhone, loadContacts(), user?.id ?? ''));
    }
  };

  const flushLateReports = async (key: string, alertId: string) => {
    const list = lateReportsRef.current.get(key);
    if (!list || list.length === 0) return;
    lateReportsRef.current.delete(key);
    try {
      await api.reportDeviceDeliveries(alertId, list, activeAlertRef.current?.deviceProofNonce);
    } catch {
      // best effort: the alert itself is already recorded
    }
  };

  const handleDeviceDelivery = (e: SmsDeliveryEvent) => {
    const [key, contactId] = e.id.split(DEVICE_ID_SEPARATOR);
    if (!key || !contactId) return;
    const status: DeviceDeliveryReportDTO['status'] = e.status === 'delivered' ? 'DELIVERED' : 'FAILED';
    const report: DeviceDeliveryReportDTO = { contactId, status, error: status === 'FAILED' ? 'Delivery failed' : null };

    setActiveAlert((prev) =>
      prev && prev.idempotencyKey === key
        ? {
            ...prev,
            deliveries: prev.deliveries.map((d) =>
              d.contactId === contactId && d.status !== DeliveryStatus.DELIVERED
                ? { ...d, status: status as DeliveryStatus, lastErrorCode: report.error ?? null }
                : d
            ),
          }
        : prev
    );
    void offlineQueue.updateDeviceDelivery(key, contactId, status, report.error);

    const current = activeAlertRef.current;
    if (current && current.idempotencyKey === key && !current.id.startsWith('local:')) {
      api.reportDeviceDeliveries(current.id, [report], current.deviceProofNonce).catch(() => {});
    } else {
      const arr = lateReportsRef.current.get(key) ?? [];
      arr.push(report);
      lateReportsRef.current.set(key, arr);
    }
  };

  const fetchLatestAlert = async () => {
    try {
      const myAlerts = await api.getMyAlerts();
      if (myAlerts && myAlerts.length > 0) {
        // Find latest active/open alert
        const openAlert = myAlerts.find((a) => a.resolutionStatus === AlertResolutionStatus.OPEN);
        if (openAlert) {
          setActiveAlert(openAlert);
        }
      }
    } catch {
      // offline or error, ignore
    }
  };

  const processOfflineQueue = async () => {
    if (processingQueue.current) return; // one pass at a time (mount/online/focus can overlap)
    processingQueue.current = true;
    try {
      const queued = await offlineQueue.getAll();
      for (const record of queued) {
        // Past 10 minutes, require explicit confirmation before sending
        // (Phone-sent records are only a server record of texts already delivered: never "stale".)
        if (!record.sentByDevice && offlineQueue.isStale(record) && !record.confirmedAfterStale) continue;
        try {
          await offlineQueue.recordAttempt(record.idempotencyKey);
          const alert = await api.createAlert({
            idempotencyKey: record.idempotencyKey,
            latitude: record.latitude,
            longitude: record.longitude,
            accuracy: record.accuracy ?? null,
            locationAvailable: record.locationAvailable,
            triggeredAt: record.triggeredAt,
            ...(record.sentByDevice
              ? { sentByDevice: true, deviceDeliveries: record.deviceDeliveries ?? [] }
              : {}),
          });
          await offlineQueue.remove(record.idempotencyKey);
          setActiveAlert(alert);
          setErrorMessage(null);
          setInfoMessage(null);
          await flushLateReports(record.idempotencyKey, alert.id);
        } catch (err: any) {
          if (err instanceof ApiError && err.code === 'ALERT_ALREADY_OPEN') {
            // An alert is already active server-side; this queued duplicate must not retry forever.
            await offlineQueue.remove(record.idempotencyKey);
            if (err.body?.alert) setActiveAlert(err.body.alert);
          } else if (
            err instanceof ApiError &&
            err.status >= 400 &&
            err.status < 500 &&
            err.status !== 401 &&
            err.status !== 429
          ) {
            // Permanent rejection (e.g. NO_CONTACTS): surface it rather than silently retrying.
            setErrorMessage(`A queued alert was rejected by the server: ${err.message}`);
            await offlineQueue.remove(record.idempotencyKey);
          }
          // Network/5xx/auth-offline errors: leave queued for the next trigger.
        }
      }
    } finally {
      processingQueue.current = false;
      await checkOfflineQueue();
    }
  };

  // Hold-to-confirm gesture handlers
  // A queued alert only blocks a NEW SOS while it is still going to be sent (or already was, from
  // the phone). A stale one held for confirmation must not stop someone from asking for help now.
  const queueBlocksNewSos = queuedAlerts.some(
    (q) => q.sentByDevice || q.confirmedAfterStale || !offlineQueue.isStale(q)
  );

  const startHolding = () => {
    if (loading || activeAlert?.resolutionStatus === AlertResolutionStatus.OPEN || queueBlocksNewSos) return;
    // touchstart + emulated mousedown, or key auto-repeat, must not start a second hold loop.
    if (holdStartTime.current !== null || triggerInFlight.current) return;
    setHolding(true);
    holdStartTime.current = Date.now();

    const updateHold = () => {
      if (holdStartTime.current === null) return;
      const elapsed = Date.now() - holdStartTime.current;
      const progress = Math.min(100, (elapsed / HOLD_DURATION_MS) * 100);
      setHoldProgress(progress);

      if (progress >= 100) {
        // Reset the gesture fully: otherwise the ring stays full after the alert is resolved.
        holdStartTime.current = null;
        holdAnimFrame.current = null;
        setHolding(false);
        setHoldProgress(0);
        void triggerSos();
      } else {
        holdAnimFrame.current = requestAnimationFrame(updateHold);
      }
    };

    holdAnimFrame.current = requestAnimationFrame(updateHold);
  };

  const stopHolding = () => {
    setHolding(false);
    holdStartTime.current = null;
    if (holdAnimFrame.current !== null) {
      cancelAnimationFrame(holdAnimFrame.current);
      holdAnimFrame.current = null;
    }
    setHoldProgress(0);
  };

  /**
   * Texts the contacts from this phone's own SIM (no internet needed), then records the alert on
   * the server (online now, or queued). Returns false when the phone could not send ANY text, so
   * the caller falls back to the server path; true when the alert is handled.
   */
  const triggerFromPhone = async (payload: CreateAlertDTO, tier: 'CRITICAL' | 'EVERYDAY'): Promise<boolean> => {
    // Contacts: the on-phone copy (works offline); fetch only if there is none and we are online.
    let contacts: CachedContact[] = loadContacts();
    if (contacts.length === 0 && navigator.onLine) {
      try {
        const fresh = await api.getContacts();
        saveContacts(fresh);
        contacts = loadContacts();
      } catch {
        // offline
      }
    }
    if (contacts.length === 0) {
      setErrorMessage('Add at least one emergency contact before using SOS.');
      return true; // nothing else can be tried
    }

    const allContacts = contacts;
    contacts = contacts.filter((c) => (c.tier ?? 'EVERYDAY') === tier);

    // Volume (CRITICAL) SOS must still reach someone. If the user has not marked any
    // contact as Critical, fall back to every saved contact rather than silently failing.
    // Track this so the server record is not filtered to an empty CRITICAL set.
    let effectiveTier: 'CRITICAL' | 'EVERYDAY' | undefined = tier;
    if (contacts.length === 0 && tier === 'CRITICAL') {
      contacts = allContacts;
      effectiveTier = undefined; // server: all opted-in contacts
      setInfoMessage(
        'No Critical contacts configured — notifying all emergency contacts. Mark contacts as Critical under Contacts for the volume shortcut.'
      );
    } else if (contacts.length === 0) {
      setErrorMessage(
        tier === 'CRITICAL'
          ? 'Add at least one Critical emergency contact for the volume SOS shortcut.'
          : 'Add at least one emergency contact before using SOS.'
      );
      return true;
    }

    const key = payload.idempotencyKey;
    const userId = user?.id ?? '';
    const message = buildSosMessage({
      name: user?.name || '',
      latitude: payload.latitude ?? null,
      longitude: payload.longitude ?? null,
    });

    // Show progress immediately: every contact "sending", updated as each result comes in.
    setActiveAlert(buildLocalAlert(payload, contacts, userId));
    const results = await sendSosFromDevice(contacts, message, key, (r) => {
      setActiveAlert((prev) =>
        prev && prev.idempotencyKey === key
          ? {
              ...prev,
              deliveries: prev.deliveries.map((d) =>
                d.contactId === r.contactId
                  ? { ...d, status: r.status as DeliveryStatus, lastErrorCode: r.error ?? null, attempts: 1 }
                  : d
              ),
            }
          : prev
      );
    });

    if (results.every((r) => r.status === 'FAILED')) {
      // Nothing left the phone (no signal, airplane mode...): let the server try instead.
      setActiveAlert(null);
      setErrorMessage(
        `Could not send SMS from this phone (${results[0]?.error || 'unknown error'}). Trying the server...`
      );
      return false;
    }

    const full: CreateAlertDTO = {
      ...payload,
      sentByDevice: true,
      deviceDeliveries: results,
      recipientTier: effectiveTier,
    };
    setActiveAlert(buildLocalAlert(full, contacts, userId));

    // Record it on the server: online now, otherwise queued (the texts are already out).
    const keepForLater = async () => {
      try {
        await offlineQueue.enqueue(full);
        await checkOfflineQueue();
        setInfoMessage('SOS texts were sent from this phone. The record will upload when you are back online.');
      } catch {
        setInfoMessage('SOS texts were sent, but this device could not save the record for upload.');
      }
    };

    if (!navigator.onLine) {
      await keepForLater();
      return true;
    }
    try {
      const alert = await api.createAlert(full);
      setActiveAlert(alert);
      await flushLateReports(key, alert.id);
    } catch (err: any) {
      if (err instanceof ApiError && err.status >= 400 && err.status < 500 && err.status !== 401 && err.status !== 429) {
        setInfoMessage(
          `SOS texts were sent from this phone, but the server did not record the alert: ${err.message}`
        );
      } else {
        await keepForLater();
      }
    }
    return true;
  };

  const triggerSos = async (tier: 'CRITICAL' | 'EVERYDAY' = 'EVERYDAY') => {
    if (triggerInFlight.current) return;
    triggerInFlight.current = true;

    // Immediate feedback: the gesture registered, independent of the network outcome.
    void confirmHaptic();
    setRegistered(true);
    setTimeout(() => setRegistered(false), 4000);

    setLoading(true);
    setErrorMessage(null);
    setInfoMessage(null);

    const hasFix = locationStatus === 'acquired' && coords.latitude != null && coords.longitude != null;
    const payload = {
      idempotencyKey: offlineQueue.generateIdempotencyKey(),
      latitude: hasFix ? coords.latitude : null,
      longitude: hasFix ? coords.longitude : null,
      accuracy: hasFix ? coords.accuracy : null,
      locationAvailable: hasFix,
      triggeredAt: new Date().toISOString(),
      recipientTier: tier,
    };

    const askEmergencyServices = () => {
      if (tier !== 'CRITICAL') return;
      if (window.confirm('Notify emergency services now? OK opens the phone dialer for 112.')) {
        if (smsSenderSupported) void smsSender.dial({ number: '112' });
        else window.location.href = 'tel:112';
      }
    };

    const queueIt = async (reason: string) => {
      try {
        await offlineQueue.enqueue(payload);
        await checkOfflineQueue();
        // State 2: queued, not yet sent.
        setErrorMessage(
          `${reason} Your alert is saved on this device and will send automatically when you reconnect.`
        );
      } catch (e: any) {
        // State 1: could not even queue it — the user must act (call emergency services directly).
        setErrorMessage(
          `Your alert could NOT be saved or sent (${e?.message || 'storage error'}). Call emergency services directly.`
        );
      }
    };

    try {
      // Phone SMS first (works without internet); the server path below is the fallback.
      if (deviceSmsState === 'ready' && (await triggerFromPhone(payload, tier))) {
        return;
      }
      if (!navigator.onLine) {
        await queueIt('You are offline.');
        return;
      }
      let alert;
      try {
        alert = await api.createAlert(payload);
      } catch (firstErr: any) {
        // Volume SOS with no Critical contacts: retry without tier so all contacts are notified.
        if (tier === 'CRITICAL' && firstErr instanceof ApiError && firstErr.code === 'NO_CONTACTS') {
          const { recipientTier: _drop, ...withoutTier } = payload;
          alert = await api.createAlert(withoutTier);
          setInfoMessage(
            'No Critical contacts configured — notified all emergency contacts. Mark contacts as Critical under Contacts for the volume shortcut.'
          );
        } else {
          throw firstErr;
        }
      }
      setActiveAlert(alert);
      setErrorMessage(null);
    } catch (err: any) {
      if (err instanceof ApiError && err.code === 'ALERT_ALREADY_OPEN') {
        if (err.body?.alert) setActiveAlert(err.body.alert);
        setErrorMessage('You already have an active alert.');
      } else if (err instanceof ApiError && (err.code === 'OFFLINE' || err.status === 0)) {
        await queueIt('Network connection lost.');
      } else if (err instanceof ApiError && (err.status >= 500 || err.status === 429)) {
        // Server down / overloaded / rate limited: the alert is valid, so keep it and retry with backoff
        // instead of dropping it and asking the user to press again.
        await queueIt('The server could not take your alert right now.');
      } else {
        setErrorMessage(err.message || 'Failed to trigger emergency alert');
      }
    } finally {
      askEmergencyServices();
      triggerInFlight.current = false;
      setLoading(false);
    }
  };

  const isLocalAlert = Boolean(activeAlert?.id.startsWith('local:'));

  const handleResolveAlert = async () => {
    if (!activeAlert || isLocalAlert) return;
    try {
      const updated = await api.resolveAlert(activeAlert.id);
      setActiveAlert(updated);
    } catch (err: any) {
      setErrorMessage(err.message || 'Failed to resolve alert');
    }
  };

  const handleCancelAlert = async () => {
    if (!activeAlert || isLocalAlert) return;
    if (!window.confirm('Cancel emergency alert? Only use this if triggered by mistake.')) return;
    try {
      const updated = await api.cancelAlert(activeAlert.id);
      setActiveAlert(updated);
    } catch (err: any) {
      setErrorMessage(err.message || 'Failed to cancel alert');
    }
  };

  const handleConfirmStaleQueued = async (idempotencyKey: string) => {
    await offlineQueue.confirmStale(idempotencyKey);
    processOfflineQueue();
  };

  const handleDiscardQueued = async (idempotencyKey: string) => {
    await offlineQueue.remove(idempotencyKey);
    checkOfflineQueue();
  };

  // Keep a stable ref so the always-on volume bridge can call the latest triggerSos
  // without re-subscribing every render (triggerSos closes over location/contacts state).
  const triggerSosRef = useRef(triggerSos);
  triggerSosRef.current = triggerSos;

  useEffect(() => {
    return setVolumeSosHandler(() => {
      if (!triggerInFlight.current) void triggerSosRef.current('CRITICAL');
    });
  }, []);

  useEffect(() => {
    const refresh = () => {
      void volumeSosAccessibilityEnabled().then(setVolumeSosEnabled);
    };
    refresh();
    return onResume(refresh);
  }, []);

  return (
    <div className="max-w-2xl mx-auto px-4 py-8">
      {/* Offline Queued Alerts Notification */}
      {queuedAlerts.some((q) => !q.sentByDevice) && (
        <div className="mb-6 space-y-3">
          {queuedAlerts
            .filter((q) => !q.sentByDevice)
            .map((q) => {
              const stale = offlineQueue.isStale(q);
              return (
                <div
                  key={q.idempotencyKey}
                  className="p-4 rounded-2xl bg-amber-950/40 border border-amber-800 text-amber-200"
                >
                  <div className="flex items-start justify-between">
                    <div className="flex items-center space-x-2">
                      <WifiOff className="w-5 h-5 text-amber-400 shrink-0" />
                      <div>
                        <h3 className="text-sm font-semibold">
                          {stale ? 'Stale Offline Alert Held (>10 mins)' : 'Queued Alert — Waiting for network'}
                        </h3>
                        <p className="text-xs text-amber-300/80 mt-0.5">
                          Triggered at {new Date(q.triggeredAt).toLocaleTimeString()}. Attempts: {q.attempts}.
                        </p>
                      </div>
                    </div>
                  </div>

                  {stale ? (
                    <div className="mt-3 pt-3 border-t border-amber-800/40 flex items-center justify-between">
                      <span className="text-xs text-amber-300">Emergency may have passed. Still need help?</span>
                      <div className="flex space-x-2">
                        <button
                          onClick={() => handleDiscardQueued(q.idempotencyKey)}
                          className="px-3 py-1 bg-zinc-800 hover:bg-zinc-700 text-zinc-300 text-xs rounded-lg"
                        >
                          Discard
                        </button>
                        <button
                          onClick={() => handleConfirmStaleQueued(q.idempotencyKey)}
                          className="px-3 py-1 bg-amber-600 hover:bg-amber-500 text-black font-semibold text-xs rounded-lg"
                        >
                          Yes, Send Now
                        </button>
                      </div>
                    </div>
                  ) : (
                    <div className="mt-2 text-[11px] text-amber-400/80 flex items-center space-x-1.5">
                      <Loader2 className="w-3 h-3 animate-spin" />
                      <span>Retrying automatically when network is available...</span>
                    </div>
                  )}
                </div>
              );
            })}
        </div>
      )}

      {infoMessage && (
        <div role="status" className="mb-6 p-3 rounded-2xl bg-sky-950/60 border border-sky-800 text-sky-200 text-sm">
          {infoMessage}
        </div>
      )}

      {registered && (
        <div role="status" className="mb-6 p-3 rounded-2xl bg-emerald-950/60 border border-emerald-800 text-emerald-200 text-sm">
          SOS registered — sending now…
        </div>
      )}

      {activeAlert?.resolutionStatus === AlertResolutionStatus.OPEN &&
        activeAlert.deliveries.some((d) => d.status === DeliveryStatus.FAILED) && (
          // State 3: sent, but some contacts failed.
          <div role="alert" className="mb-6 p-4 rounded-2xl bg-red-950/60 border border-red-800 text-red-200 text-sm">
            Alert sent, but {activeAlert.deliveries.filter((d) => d.status === DeliveryStatus.FAILED).length} of{' '}
            {activeAlert.deliveries.length} contacts could not be reached. Try calling them directly.
          </div>
        )}

      {errorMessage && (
        <div className="mb-6 p-4 rounded-2xl bg-red-950/60 border border-red-800 text-red-200 text-sm flex items-start space-x-3">
          <AlertTriangle className="w-5 h-5 text-red-400 shrink-0" />
          <p>{errorMessage}</p>
        </div>
      )}

      {activeAlert ? (
        <div className="bg-zinc-900 border border-red-900/60 rounded-3xl p-6 sm:p-8 shadow-2xl relative overflow-hidden">
          <div className="absolute top-0 left-0 right-0 h-1 bg-gradient-to-r from-red-600 via-red-500 to-red-600 animate-pulse"></div>

          <div className="flex items-center justify-between pb-6 border-b border-zinc-800">
            <div className="flex items-center space-x-3">
              <div className="w-3 h-3 rounded-full bg-red-500 animate-ping"></div>
              <div>
                <span className="text-xs font-mono uppercase tracking-widest text-red-400 font-semibold">
                  Active Emergency Alert
                </span>
                <h2 className="text-xl font-bold text-white">Broadcast In Progress</h2>
              </div>
            </div>

            <div className="text-right">
              <span className="text-xs text-zinc-400 block font-mono">
                {new Date(activeAlert.triggeredAt).toLocaleTimeString()}
              </span>
              {activeAlert.delayed && (
                <span className="inline-block mt-1 px-2 py-0.5 rounded bg-amber-500/20 text-amber-400 border border-amber-500/30 text-[10px] font-semibold">
                  Delayed Transmission
                </span>
              )}
            </div>
          </div>

          {/* Location Status Card */}
          <div className="my-6 p-4 rounded-2xl bg-zinc-950 border border-zinc-800/80 flex items-center justify-between">
            <div className="flex items-center space-x-3">
              {activeAlert.locationAvailable ? (
                <MapPin className="w-5 h-5 text-emerald-400" />
              ) : (
                <MapPinOff className="w-5 h-5 text-zinc-500" />
              )}
              <div>
                <span className="text-xs text-zinc-400 block">Emergency Coordinates</span>
                <span className="text-sm font-medium text-white font-mono">
                  {activeAlert.locationAvailable && activeAlert.latitude != null && activeAlert.longitude != null
                    ? `${activeAlert.latitude.toFixed(5)}, ${activeAlert.longitude.toFixed(5)}`
                    : 'Location Unavailable (Proceeded safely)'}
                </span>
                {activeAlert.locationAvailable && activeAlert.accuracy != null && (
                  <span
                    className={`block text-[11px] ${
                      activeAlert.accuracy > GPS_POOR_ACCURACY_M ? 'text-amber-400' : 'text-zinc-500'
                    }`}
                  >
                    {activeAlert.accuracy > GPS_POOR_ACCURACY_M ? 'Approximate location' : 'Precise location'} (±
                    {Math.round(activeAlert.accuracy)} m)
                  </span>
                )}
              </div>
            </div>

            {activeAlert.locationAvailable && activeAlert.latitude != null && activeAlert.longitude != null && (
              <a
                href={`https://maps.google.com/?q=${activeAlert.latitude},${activeAlert.longitude}`}
                target="_blank"
                rel="noreferrer"
                className="text-xs text-red-400 hover:text-red-300 underline"
              >
                View on Map
              </a>
            )}
          </div>

          {/* Delivery Status Per Contact */}
          <div className="space-y-3 mb-8">
            <div className="flex items-center justify-between">
              <h3 className="text-xs font-semibold uppercase tracking-wider text-zinc-400">Verified Recipient Status</h3>
              <span className="text-xs text-zinc-500 font-mono">
                {activeAlert.deliveries.filter((d) => d.status === DeliveryStatus.DELIVERED).length} /{' '}
                {activeAlert.deliveries.length} Delivered
              </span>
            </div>

            <div className="space-y-2">
              {activeAlert.deliveries.map((delivery) => {
                let badgeClass = 'bg-zinc-800 text-zinc-400 border-zinc-700';
                let icon = <Clock className="w-3.5 h-3.5 text-zinc-400" />;
                let label = 'PENDING';

                if (delivery.status === DeliveryStatus.SENT) {
                  badgeClass = 'bg-blue-950/60 text-blue-300 border-blue-800/50';
                  icon = <Send className="w-3.5 h-3.5 text-blue-400" />;
                  label = delivery.channel === 'device-sms' ? 'SENT FROM PHONE' : 'SENT TO GATEWAY';
                } else if (delivery.status === DeliveryStatus.DELIVERED) {
                  badgeClass = 'bg-emerald-950/60 text-emerald-300 border-emerald-800/50';
                  icon = <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400" />;
                  label = 'DELIVERED';
                } else if (delivery.status === DeliveryStatus.FAILED) {
                  badgeClass = 'bg-red-950/60 text-red-300 border-red-800/50';
                  icon = <AlertTriangle className="w-3.5 h-3.5 text-red-400" />;
                  label = 'FAILED';
                }

                return (
                  <div
                    key={delivery.id}
                    className="p-3.5 rounded-xl bg-zinc-950/80 border border-zinc-800/80 flex items-center justify-between"
                  >
                    <div>
                      <div className="font-medium text-sm text-white">{delivery.contactNameSnapshot}</div>
                      <div className="text-xs text-zinc-400 font-mono flex items-center space-x-1 mt-0.5">
                        <Phone className="w-3 h-3 text-zinc-500" />
                        <span>{delivery.contactPhoneSnapshot}</span>
                        {delivery.relationshipSnapshot && (
                          <span className="text-zinc-500">• {delivery.relationshipSnapshot}</span>
                        )}
                      </div>
                    </div>

                    <div className="text-right">
                      <span
                        className={`inline-flex items-center space-x-1.5 px-2.5 py-1 rounded-full text-xs font-medium border ${badgeClass}`}
                      >
                        {icon}
                        <span>{label}</span>
                      </span>
                      {delivery.lastErrorCode && (
                        <span className="block text-[11px] text-red-400 mt-1 max-w-[140px] truncate">
                          {delivery.lastErrorCode}
                        </span>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          {/* Incident Resolution Actions */}
          <div className="pt-4 border-t border-zinc-800 flex flex-col sm:flex-row gap-3">
            <button
              onClick={handleResolveAlert}
              disabled={isLocalAlert}
              className="flex-1 bg-emerald-600 hover:bg-emerald-500 disabled:opacity-40 disabled:cursor-not-allowed text-white font-semibold py-3 px-4 rounded-xl flex items-center justify-center space-x-2 transition shadow-lg shadow-emerald-950/50"
            >
              <Check className="w-4 h-4" />
              <span>I Am Safe (Mark Resolved)</span>
            </button>

            <button
              onClick={handleCancelAlert}
              disabled={isLocalAlert}
              className="bg-zinc-800 hover:bg-zinc-700 disabled:opacity-40 disabled:cursor-not-allowed text-zinc-300 py-3 px-4 rounded-xl text-sm font-medium transition"
            >
              Cancel Alert
            </button>
          </div>
          {isLocalAlert && (
            <p className="mt-3 text-xs text-zinc-500">
              This alert is saved on your phone and will be recorded online when you reconnect. You can mark it resolved
              once it has synced.
            </p>
          )}
        </div>
      ) : (
        /* SOS Trigger Screen */
        <div className="flex flex-col items-center justify-center py-6">
          {TEST_MODE && (
            <div className="mb-3 text-xs font-bold text-amber-300 bg-amber-950/50 border border-amber-700 px-3 py-1.5 rounded-full">
              TEST MODE: texts are marked &quot;NOT A REAL EMERGENCY&quot;
            </div>
          )}
          {deviceSmsState === 'ready' && (
            <div className="mb-4 text-xs text-emerald-300 bg-emerald-950/40 border border-emerald-900 px-3 py-1.5 rounded-full">
              SMS from this phone: ON (works without internet)
            </div>
          )}
          {deviceSmsState === 'denied' && (
            <div className="mb-4 max-w-sm text-center text-xs text-amber-200 bg-amber-950/40 border border-amber-800 px-3 py-2 rounded-2xl">
              Allow SMS so your SOS can be texted from this phone even with no internet.
              <button
                onClick={async () => setDeviceSmsState(await initDeviceSms())}
                className="ml-2 underline font-semibold"
              >
                Allow
              </button>
              <div className="mt-1 text-amber-300/70">
                If no prompt appears: Settings &gt; Apps &gt; SEAS &gt; Permissions &gt; SMS.
              </div>
            </div>
          )}
          {/* Geolocation indicator pill */}
          <div className="mb-8 flex items-center space-x-2 bg-zinc-900 border border-zinc-800 px-4 py-2 rounded-full text-xs text-zinc-300">
            {locationStatus === 'acquired' ? (
              <>
                {coords.accuracy != null && coords.accuracy > GPS_POOR_ACCURACY_M ? (
                  <>
                    <MapPin className="w-4 h-4 text-amber-400" />
                    <span>Approximate location (±{Math.round(coords.accuracy)} m)</span>
                  </>
                ) : (
                  <>
                    <MapPin className="w-4 h-4 text-emerald-400" />
                    <span>GPS Ready{coords.accuracy != null ? ` (±${Math.round(coords.accuracy)} m)` : ''}</span>
                  </>
                )}
              </>
            ) : locationStatus === 'unavailable' ? (
              <>
                <MapPinOff className="w-4 h-4 text-amber-400" />
                <span>GPS Unavailable — SOS Will Still Send</span>
              </>
            ) : (
              <>
                <Loader2 className="w-4 h-4 text-blue-400 animate-spin" />
                <span>Acquiring Geolocation...</span>
              </>
            )}
          </div>

          {/* Hold-to-confirm SOS Button */}
          <div className="relative flex items-center justify-center select-none touch-none">
            {/* SVG Circular Progress Ring */}
            <svg className="w-64 h-64 transform -rotate-90 pointer-events-none" viewBox="0 0 100 100">
              {/* Background Ring */}
              <circle
                cx="50"
                cy="50"
                r="44"
                stroke="currentColor"
                strokeWidth="4"
                className="text-zinc-800/80"
                fill="transparent"
              />
              {/* Active Hold Progress Ring */}
              <circle
                cx="50"
                cy="50"
                r="44"
                stroke="currentColor"
                strokeWidth="6"
                strokeDasharray={276.46}
                strokeDashoffset={276.46 - (276.46 * holdProgress) / 100}
                strokeLinecap="round"
                className="text-red-500 transition-all duration-75"
                fill="transparent"
              />
            </svg>

            {/* Central Dominant Trigger Button */}
            <button
              onMouseDown={startHolding}
              onMouseUp={stopHolding}
              onMouseLeave={stopHolding}
              onTouchStart={startHolding}
              onTouchEnd={stopHolding}
              onTouchCancel={stopHolding}
              onKeyDown={(e) => {
                if (e.key === ' ' || e.key === 'Enter') {
                  if (!holding) startHolding();
                }
              }}
              onKeyUp={(e) => {
                if (e.key === ' ' || e.key === 'Enter') {
                  stopHolding();
                }
              }}
              disabled={loading}
              className={`absolute w-52 h-52 rounded-full flex flex-col items-center justify-center cursor-pointer transition-all duration-200 outline-none focus:ring-4 focus:ring-red-500/50 ${
                holding
                  ? 'bg-red-700 scale-95 shadow-inner'
                  : 'bg-red-600 hover:bg-red-500 active:scale-95 shadow-2xl shadow-red-950/80'
              }`}
              aria-label="Hold for 1.5 seconds to trigger Emergency SOS"
            >
              <ShieldAlert className="w-16 h-16 text-white mb-1 drop-shadow" />
              <span className="text-3xl font-black tracking-widest text-white">SOS</span>
              <span className="text-xs text-red-200 font-medium tracking-wide mt-1">
                {holding ? 'HOLD...' : 'HOLD 1.5s'}
              </span>
            </button>
          </div>

          <p className="text-xs text-zinc-400 mt-8 text-center max-w-sm">
            Press and hold the button for 1.5 seconds. Releasing before the ring fills cancels activation.
          </p>

          {smsSenderSupported &&
            (volumeSosEnabled ? (
              <div className="mb-4 text-xs text-emerald-300 bg-emerald-950/40 border border-emerald-900 px-3 py-1.5 rounded-full">
                Triple-volume SOS: ON
              </div>
            ) : (
              <button
                type="button"
                onClick={() => void openVolumeSosAccessibilitySettings()}
                className="mb-4 max-w-sm text-center text-xs text-amber-200 bg-amber-950/40 border border-amber-800 px-3 py-2 rounded-2xl"
              >
                Enable triple-volume SOS in Accessibility settings
              </button>
            ))}
        </div>
      )}
    </div>
  );
};