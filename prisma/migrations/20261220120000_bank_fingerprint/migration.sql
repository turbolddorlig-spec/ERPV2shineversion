-- #181: нэг гүйлгээ Gmail ба утаснаас (MacroDroid) хоёуланд ирсэн ч нэг л удаа — данс + дүн + үлдэгдлээр таних
ALTER TABLE "BankTransaction" ADD COLUMN "fingerprint" TEXT;
CREATE UNIQUE INDEX "BankTransaction_fingerprint_key" ON "BankTransaction"("fingerprint");
