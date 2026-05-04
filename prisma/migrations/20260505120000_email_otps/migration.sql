CREATE TABLE IF NOT EXISTS "email_otps" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "codeHash" TEXT NOT NULL,
    "purpose" TEXT NOT NULL DEFAULT 'password_reset',
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "usedAt" TIMESTAMP(3),
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "email_otps_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "email_otps_email_purpose_idx" ON "email_otps"("email", "purpose");
