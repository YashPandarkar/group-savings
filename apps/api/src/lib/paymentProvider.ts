import { env } from "../config/env";
import { razorpayProvider } from "./providers/razorpay";
import { simulatorProvider } from "./providers/simulator";
import type { PaymentProvider } from "./providers/types";

export { ProviderError } from "./providers/types";

// Chosen once at start-up from PAYMENT_PROVIDER (env.ts has already refused unsafe combinations).
export const provider: PaymentProvider =
  env.PAYMENT_PROVIDER === "razorpay" ? razorpayProvider() : simulatorProvider;
