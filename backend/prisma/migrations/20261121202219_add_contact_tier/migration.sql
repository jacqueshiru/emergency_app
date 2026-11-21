-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "phoneNumber" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "role" TEXT NOT NULL DEFAULT 'USER',
    "adminMfaSecret" TEXT,
    "adminMfaEnabled" BOOLEAN NOT NULL DEFAULT false,
    "passwordResetRequired" BOOLEAN NOT NULL DEFAULT false,
    "totpSecret" TEXT,
    "totpEnabled" BOOLEAN NOT NULL DEFAULT false,
    "adminMfaVerifiedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "EmergencyContact" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "phoneNumber" TEXT NOT NULL,
    "relationship" TEXT,
    "tier" TEXT NOT NULL DEFAULT 'EVERYDAY',
    "consentStatus" TEXT NOT NULL DEFAULT 'PENDING',
    "consentAt" DATETIME,
    "optOutAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "EmergencyContact_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Alert" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "latitude" REAL,
    "longitude" REAL,
    "accuracy" REAL,
    "locationAvailable" BOOLEAN NOT NULL,
    "triggeredAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "delayed" BOOLEAN NOT NULL DEFAULT false,
    "status" TEXT NOT NULL DEFAULT 'CREATED',
    "resolutionStatus" TEXT NOT NULL DEFAULT 'OPEN',
    "resolvedAt" DATETIME,
    "deviceProofNonce" TEXT,
    CONSTRAINT "Alert_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "AlertDelivery" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "alertId" TEXT NOT NULL,
    "contactId" TEXT,
    "contactNameSnapshot" TEXT NOT NULL,
    "contactPhoneSnapshot" TEXT NOT NULL,
    "relationshipSnapshot" TEXT,
    "channel" TEXT NOT NULL DEFAULT 'sms',
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "deviceVerified" BOOLEAN NOT NULL DEFAULT false,
    "providerMessageId" TEXT,
    "lastErrorCode" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastAttemptAt" DATETIME,
    "nextRetryAt" DATETIME,
    "claimedAt" DATETIME,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "AlertDelivery_alertId_fkey" FOREIGN KEY ("alertId") REFERENCES "Alert" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "AlertDelivery_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "EmergencyContact" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "OtpRequest" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "phoneNumber" TEXT NOT NULL,
    "codeHash" TEXT NOT NULL,
    "expiresAt" DATETIME NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "consumedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "RefreshSession" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" DATETIME NOT NULL,
    "revokedAt" DATETIME,
    "adminMfaVerifiedAt" DATETIME,
    CONSTRAINT "RefreshSession_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "AuditLog" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "actorId" TEXT,
    "action" TEXT NOT NULL,
    "targetId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateIndex
CREATE UNIQUE INDEX "User_phoneNumber_key" ON "User"("phoneNumber");

-- CreateIndex
CREATE UNIQUE INDEX "EmergencyContact_userId_phoneNumber_key" ON "EmergencyContact"("userId", "phoneNumber");

-- CreateIndex
CREATE UNIQUE INDEX "Alert_idempotencyKey_key" ON "Alert"("idempotencyKey");

-- CreateIndex
CREATE INDEX "AlertDelivery_status_nextRetryAt_idx" ON "AlertDelivery"("status", "nextRetryAt");

-- CreateIndex
CREATE UNIQUE INDEX "RefreshSession_tokenHash_key" ON "RefreshSession"("tokenHash");
