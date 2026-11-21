export enum Role {
  USER = 'USER',
  ADMIN = 'ADMIN',
}

export enum AlertProcessingStatus {
  CREATED = 'CREATED',
  PROCESSING = 'PROCESSING',
  COMPLETED = 'COMPLETED',
}

export enum AlertResolutionStatus {
  OPEN = 'OPEN',
  RESOLVED = 'RESOLVED',
  CANCELLED = 'CANCELLED',
}

export enum DeliveryStatus {
  PENDING = 'PENDING',
  SENT = 'SENT',
  DELIVERED = 'DELIVERED',
  FAILED = 'FAILED',
}

export interface UserDTO {
  id: string;
  phoneNumber: string;
  name: string;
  role: Role;
  createdAt: string;
  updatedAt: string;
}

export type ContactTier = 'CRITICAL' | 'EVERYDAY';

export interface EmergencyContactDTO {
  id: string;
  userId: string;
  name: string;
  phoneNumber: string;
  relationship: string | null;
  tier: ContactTier;
  consentStatus: 'PENDING' | 'OPTED_IN' | 'OPTED_OUT';
  consentAt: string | null;
  optOutAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface AlertDeliveryDTO {
  id: string;
  alertId: string;
  contactId: string | null;
  contactNameSnapshot: string;
  contactPhoneSnapshot: string;
  relationshipSnapshot: string | null;
  channel: string;
  status: DeliveryStatus;
  deviceVerified?: boolean;
  providerMessageId: string | null;
  lastErrorCode: string | null;
  attempts: number;
  lastAttemptAt: string | null;
  nextRetryAt: string | null;
  updatedAt: string;
}

export interface AlertDTO {
  id: string;
  userId: string;
  user?: Pick<UserDTO, 'id' | 'name' | 'phoneNumber'>;
  idempotencyKey: string;
  latitude: number | null;
  longitude: number | null;
  accuracy?: number | null;
  locationAvailable: boolean;
  triggeredAt: string;
  delayed: boolean;
  status: AlertProcessingStatus;
  resolutionStatus: AlertResolutionStatus;
  resolvedAt: string | null;
  deviceProofNonce?: string | null;
  deliveries: AlertDeliveryDTO[];
}

export interface AuditLogDTO {
  id: string;
  actorId: string | null;
  action: string;
  targetId: string | null;
  createdAt: string;
}

// Request / Response payloads
export interface RequestOtpDTO {
  phoneNumber: string;
  name?: string;
}

export interface VerifyOtpDTO {
  phoneNumber: string;
  code: string;
}

export interface AuthTokensDTO {
  accessToken: string;
  refreshToken: string;
  user: UserDTO;
}

export interface RefreshTokenDTO {
  refreshToken: string;
}

export interface CreateContactDTO {
  name: string;
  phoneNumber: string;
  relationship?: string;
  tier?: ContactTier;
}

export interface UpdateContactDTO {
  name?: string;
  phoneNumber?: string;
  relationship?: string;
  tier?: ContactTier;
}

/** Result of texting one contact from the user's own phone (SMS sent by the Android app itself). */
export interface DeviceDeliveryReportDTO {
  contactId: string;
  status: 'SENT' | 'DELIVERED' | 'FAILED';
  error?: string | null;
}

export interface CreateAlertDTO {
  idempotencyKey: string;
  /** true = the phone already texted the contacts; the server records the alert and does NOT send SMS. */
  sentByDevice?: boolean;
  recipientTier?: 'CRITICAL' | 'EVERYDAY';
  deviceDeliveries?: DeviceDeliveryReportDTO[];
  deviceProofNonce?: string;
  latitude?: number | null;
  longitude?: number | null;
  accuracy?: number | null;
  locationAvailable: boolean;
  triggeredAt?: string;
}

export interface AfricaTalkingDeliveryWebhookDTO {
  id: string;
  status: string; // "Success", "Failed", "Sent", "Buffered", "Rejected"
  phoneNumber: string;
  networkCode?: string;
  failureReason?: string;
  retryCount?: string;
}
