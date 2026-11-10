-- CreateTable
CREATE TABLE "IdemKey" (
    "key" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "IdemKey_pkey" PRIMARY KEY ("key")
);
