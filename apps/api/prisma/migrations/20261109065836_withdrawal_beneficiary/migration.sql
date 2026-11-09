-- AlterTable
ALTER TABLE "withdrawals" ADD COLUMN     "beneficiaryId" TEXT,
ADD COLUMN     "completedById" TEXT,
ADD COLUMN     "method" "PaymentMethod";

-- AddForeignKey
ALTER TABLE "withdrawals" ADD CONSTRAINT "withdrawals_beneficiaryId_fkey" FOREIGN KEY ("beneficiaryId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "withdrawals" ADD CONSTRAINT "withdrawals_completedById_fkey" FOREIGN KEY ("completedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
