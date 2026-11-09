// What we need from a payment provider. Razorpay and the simulator both implement this.

export type RemotePayment = {
  id: string;
  orderId: string | null;
  amountPaise: bigint;
  currency: string;
  status: string; // Razorpay: created | authorized | captured | refunded | failed
  method: string | null; // upi | card | netbanking | wallet | ...
  amountRefundedPaise: bigint;
  errorCode: string | null;
  errorDescription: string | null;
  createdAt: Date;
};

export type ProviderOrderInput = {
  receipt: string;
  amountPaise: bigint;
  notes: Record<string, string>;
};

export type ProviderErrorKind = "NOT_FOUND" | "UNAVAILABLE" | "REJECTED";

export class ProviderError extends Error {
  constructor(
    message: string,
    public readonly kind: ProviderErrorKind
  ) {
    super(message);
  }
}

export interface PaymentProvider {
  name: "razorpay" | "simulator";
  keyId: string; // PUBLIC key id, safe to send to the browser
  createOrder(input: ProviderOrderInput): Promise<{ providerOrderId: string }>;
  fetchPayment(paymentId: string): Promise<RemotePayment>;
  fetchOrderPayments(providerOrderId: string): Promise<RemotePayment[]>;
  verifyCheckoutSignature(providerOrderId: string, paymentId: string, signature: string): boolean;
  verifyWebhookSignature(rawBody: Buffer, signature: string): boolean;
}
