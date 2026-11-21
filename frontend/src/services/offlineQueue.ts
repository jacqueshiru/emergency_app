import { openDB, DBSchema, IDBPDatabase } from 'idb';
import { CreateAlertDTO, DeviceDeliveryReportDTO } from '@seas/shared';

interface QueuedAlertRecord {
  idempotencyKey: string;
  latitude: number | null;
  longitude: number | null;
  accuracy?: number | null;
  locationAvailable: boolean;
  triggeredAt: string; // ISO string
  attempts: number;
  lastAttemptAt?: string;
  confirmedAfterStale?: boolean;
  /** The phone already texted the contacts; only the server record is pending (never "stale"). */
  sentByDevice?: boolean;
  deviceDeliveries?: DeviceDeliveryReportDTO[];
}

interface SeasDB extends DBSchema {
  queued_alerts: {
    key: string;
    value: QueuedAlertRecord;
    indexes: { 'by-triggeredAt': string };
  };
}

const DB_NAME = 'seas_offline_store';
const DB_VERSION = 1;

let dbPromise: Promise<IDBPDatabase<SeasDB>> | null = null;

function getDB(): Promise<IDBPDatabase<SeasDB>> {
  if (!dbPromise) {
    dbPromise = openDB<SeasDB>(DB_NAME, DB_VERSION, {
      upgrade(db) {
        if (!db.objectStoreNames.contains('queued_alerts')) {
          const store = db.createObjectStore('queued_alerts', { keyPath: 'idempotencyKey' });
          store.createIndex('by-triggeredAt', 'triggeredAt');
        }
      },
    });
  }
  return dbPromise;
}

export const STALE_THRESHOLD_MS = 10 * 60 * 1000; // 10 minutes

export const offlineQueue = {
  /**
   * Generates a unique client idempotency key
   */
  generateIdempotencyKey(): string {
    return `alert-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
  },

  /**
   * Persists an alert to IndexedDB
   */
  async enqueue(alertData: CreateAlertDTO): Promise<QueuedAlertRecord> {
    const db = await getDB();
    const record: QueuedAlertRecord = {
      idempotencyKey: alertData.idempotencyKey,
      latitude: alertData.latitude ?? null,
      longitude: alertData.longitude ?? null,
      accuracy: alertData.accuracy ?? null,
      locationAvailable: alertData.locationAvailable,
      triggeredAt: alertData.triggeredAt || new Date().toISOString(),
      attempts: 0,
      ...(alertData.sentByDevice
        ? { sentByDevice: true, deviceDeliveries: alertData.deviceDeliveries ?? [] }
        : {}),
    };
    await db.put('queued_alerts', record);
    return record;
  },

  /** Keeps the latest carrier delivery result with a still-queued phone-sent alert. */
  async updateDeviceDelivery(
    idempotencyKey: string,
    contactId: string,
    status: DeviceDeliveryReportDTO['status'],
    error?: string | null
  ): Promise<void> {
    const db = await getDB();
    const record = await db.get('queued_alerts', idempotencyKey);
    if (!record || !record.sentByDevice) return;
    const list = (record.deviceDeliveries ?? []).map((d) =>
      d.contactId === contactId ? { ...d, status, error: error ?? null } : d
    );
    await db.put('queued_alerts', { ...record, deviceDeliveries: list });
  },

  /**
   * Retrieves all queued alerts
   */
  async getAll(): Promise<QueuedAlertRecord[]> {
    const db = await getDB();
    return db.getAll('queued_alerts');
  },

  /**
   * Checks if an alert is older than the staleness threshold (10 minutes)
   */
  isStale(record: QueuedAlertRecord): boolean {
    const triggered = new Date(record.triggeredAt).getTime();
    return Date.now() - triggered >= STALE_THRESHOLD_MS;
  },

  /**
   * Confirms a stale alert so it can be dispatched
   */
  async confirmStale(idempotencyKey: string): Promise<void> {
    const db = await getDB();
    const record = await db.get('queued_alerts', idempotencyKey);
    if (record) {
      record.confirmedAfterStale = true;
      await db.put('queued_alerts', record);
    }
  },

  /**
   * Removes alert from IndexedDB after successful transmission
   */
  async remove(idempotencyKey: string): Promise<void> {
    const db = await getDB();
    await db.delete('queued_alerts', idempotencyKey);
  },

  /**
   * Increments attempt count and timestamp
   */
  async recordAttempt(idempotencyKey: string): Promise<void> {
    const db = await getDB();
    const record = await db.get('queued_alerts', idempotencyKey);
    if (record) {
      record.attempts += 1;
      record.lastAttemptAt = new Date().toISOString();
      await db.put('queued_alerts', record);
    }
  },
};
