-- CreateEnum
CREATE TYPE "ServiceType" AS ENUM ('GMAIL', 'GITHUB', 'SLACK', 'NOTION');

-- CreateEnum
CREATE TYPE "ActionTier" AS ENUM ('AUTO', 'NUDGE', 'STEP_UP');

-- CreateEnum
CREATE TYPE "ConnectionStatus" AS ENUM ('ACTIVE', 'REVOKED');

-- CreateEnum
CREATE TYPE "AuditStatus" AS ENUM ('EXECUTED', 'APPROVED', 'DENIED', 'EXPIRED', 'FAILED', 'STEP_UP_VERIFIED', 'PENDING');

-- CreateEnum
CREATE TYPE "PendingStatus" AS ENUM ('PENDING_APPROVAL', 'APPROVED', 'DENIED', 'EXPIRED');

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "auth0UserId" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "displayName" TEXT,
    "avatarUrl" TEXT,
    "pushSubscription" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ServiceConnection" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "service" "ServiceType" NOT NULL,
    "status" "ConnectionStatus" NOT NULL DEFAULT 'ACTIVE',
    "connectedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastUsedAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),

    CONSTRAINT "ServiceConnection_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PermissionConfig" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "service" "ServiceType" NOT NULL,
    "actionType" TEXT NOT NULL,
    "tier" "ActionTier" NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PermissionConfig_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuditLog" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "agentId" TEXT,
    "connectionId" TEXT,
    "service" "ServiceType" NOT NULL,
    "actionType" TEXT NOT NULL,
    "tier" "ActionTier" NOT NULL,
    "status" "AuditStatus" NOT NULL,
    "payloadHash" TEXT,
    "metadata" JSONB,
    "approvedByUserId" TEXT,
    "approvedByIp" TEXT,
    "stepUpVerified" BOOLEAN NOT NULL DEFAULT false,
    "executedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PendingAction" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "service" "ServiceType" NOT NULL,
    "actionType" TEXT NOT NULL,
    "tier" "ActionTier" NOT NULL,
    "status" "PendingStatus" NOT NULL DEFAULT 'PENDING_APPROVAL',
    "payloadHash" TEXT NOT NULL,
    "displaySummary" TEXT NOT NULL,
    "bullJobId" TEXT,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" TIMESTAMP(3),
    "resolvedByUserId" TEXT,
    "resolvedByIp" TEXT,
    "resolvedByDevice" TEXT,
    "stepUpVerified" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "PendingAction_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_auth0UserId_key" ON "User"("auth0UserId");

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE INDEX "ServiceConnection_userId_idx" ON "ServiceConnection"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "ServiceConnection_userId_service_key" ON "ServiceConnection"("userId", "service");

-- CreateIndex
CREATE INDEX "PermissionConfig_userId_service_idx" ON "PermissionConfig"("userId", "service");

-- CreateIndex
CREATE UNIQUE INDEX "PermissionConfig_userId_service_actionType_key" ON "PermissionConfig"("userId", "service", "actionType");

-- CreateIndex
CREATE INDEX "AuditLog_userId_executedAt_idx" ON "AuditLog"("userId", "executedAt");

-- CreateIndex
CREATE INDEX "AuditLog_userId_service_idx" ON "AuditLog"("userId", "service");

-- CreateIndex
CREATE INDEX "AuditLog_agentId_idx" ON "AuditLog"("agentId");

-- CreateIndex
CREATE INDEX "PendingAction_userId_status_idx" ON "PendingAction"("userId", "status");

-- CreateIndex
CREATE INDEX "PendingAction_expiresAt_idx" ON "PendingAction"("expiresAt");

-- AddForeignKey
ALTER TABLE "ServiceConnection" ADD CONSTRAINT "ServiceConnection_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PermissionConfig" ADD CONSTRAINT "PermissionConfig_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditLog" ADD CONSTRAINT "AuditLog_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditLog" ADD CONSTRAINT "AuditLog_connectionId_fkey" FOREIGN KEY ("connectionId") REFERENCES "ServiceConnection"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PendingAction" ADD CONSTRAINT "PendingAction_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
